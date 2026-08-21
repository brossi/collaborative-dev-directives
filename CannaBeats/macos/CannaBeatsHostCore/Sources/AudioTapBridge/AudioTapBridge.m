#import "AudioTapBridge.h"

#import <AppKit/AppKit.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>

#include <math.h>
#include <stdatomic.h>

NSErrorDomain const CBAudioTapErrorDomain = @"social.cannabeats.host.audio-tap";
static NSString *const CBSpotifyBundleIdentifier = @"com.spotify.client";
static const uint32_t CBCaptureSlotCount = 64;
static const uint32_t CBCaptureMaximumFrames = 4096;
static char CBAudioDrainQueueKey;

typedef struct {
    uint32_t frameCount;
    int16_t *samples;
} CBPCMSlot;

@interface CBAudioProcessInfo ()
@property(nonatomic, readwrite) uint32_t objectID;
@property(nonatomic, readwrite) pid_t processIdentifier;
@property(nonatomic, readwrite, copy) NSString *displayName;
@property(nonatomic, readwrite, copy) NSString *bundleIdentifier;
@property(nonatomic, readwrite) BOOL isRunningOutput;
@end

@implementation CBAudioProcessInfo
@end

@interface CBPCMFrameRing () {
    CBPCMSlot *_slots;
    int16_t *_sampleStorage;
    _Atomic uint64_t _readSequence;
    _Atomic uint64_t _writeSequence;
    _Atomic uint64_t _acceptedFramesValue;
    _Atomic uint64_t _droppedPacketsValue;
    _Atomic uint64_t _droppedFramesValue;
    _Atomic uint32_t _peakBits;
}
@property(nonatomic, readwrite) uint32_t slotCount;
@property(nonatomic, readwrite) uint32_t maximumFramesPerSlot;
@end

static inline int16_t CBPCM16(float sample) {
    float bounded = fmaxf(-1.0f, fminf(1.0f, sample));
    return (int16_t)lrintf(bounded * 32767.0f);
}

static void CBUpdatePeak(_Atomic uint32_t *peakBits, float peak) {
    uint32_t oldBits = atomic_load_explicit(peakBits, memory_order_relaxed);
    uint32_t newBits;
    do {
        float previous;
        memcpy(&previous, &oldBits, sizeof(previous));
        float next = fmaxf(peak, previous * 0.92f);
        memcpy(&newBits, &next, sizeof(newBits));
    } while (!atomic_compare_exchange_weak_explicit(
        peakBits, &oldBits, newBits, memory_order_relaxed, memory_order_relaxed
    ));
}

@implementation CBPCMFrameRing

- (instancetype)initWithSlotCount:(uint32_t)slotCount
              maximumFramesPerSlot:(uint32_t)maximumFramesPerSlot {
    if (slotCount == 0 || maximumFramesPerSlot == 0 || slotCount > 1024
        || maximumFramesPerSlot > 16384) return nil;
    self = [super init];
    if (!self) return nil;
    size_t sampleCount;
    if (__builtin_mul_overflow((size_t)slotCount, (size_t)maximumFramesPerSlot * 2,
                               &sampleCount)) return nil;
    _slots = calloc(slotCount, sizeof(CBPCMSlot));
    _sampleStorage = calloc(sampleCount, sizeof(int16_t));
    if (!_slots || !_sampleStorage) {
        free(_slots);
        free(_sampleStorage);
        return nil;
    }
    self.slotCount = slotCount;
    self.maximumFramesPerSlot = maximumFramesPerSlot;
    for (uint32_t index = 0; index < slotCount; index++) {
        _slots[index].samples = _sampleStorage + ((size_t)index * maximumFramesPerSlot * 2);
    }
    return self;
}

- (BOOL)reserveFrames:(uint32_t)frames slot:(CBPCMSlot **)slot sequence:(uint64_t *)sequence {
    if (frames == 0) return NO;
    if (frames > self.maximumFramesPerSlot) {
        atomic_fetch_add_explicit(&_droppedPacketsValue, 1, memory_order_relaxed);
        atomic_fetch_add_explicit(&_droppedFramesValue, frames, memory_order_relaxed);
        return NO;
    }
    uint64_t write = atomic_load_explicit(&_writeSequence, memory_order_relaxed);
    uint64_t read = atomic_load_explicit(&_readSequence, memory_order_acquire);
    if (write - read >= self.slotCount) {
        atomic_fetch_add_explicit(&_droppedPacketsValue, 1, memory_order_relaxed);
        atomic_fetch_add_explicit(&_droppedFramesValue, frames, memory_order_relaxed);
        return NO;
    }
    *slot = &_slots[write % self.slotCount];
    *sequence = write;
    return YES;
}

- (void)commitSlot:(CBPCMSlot *)slot frames:(uint32_t)frames
           sequence:(uint64_t)sequence peak:(float)peak {
    slot->frameCount = frames;
    atomic_fetch_add_explicit(&_acceptedFramesValue, frames, memory_order_relaxed);
    CBUpdatePeak(&_peakBits, peak);
    atomic_store_explicit(&_writeSequence, sequence + 1, memory_order_release);
}

- (BOOL)enqueueInterleavedFloatSamples:(const float *)samples
                                frames:(uint32_t)frames
                              channels:(uint32_t)channels {
    if (!samples || channels == 0) return NO;
    CBPCMSlot *slot;
    uint64_t sequence;
    if (![self reserveFrames:frames slot:&slot sequence:&sequence]) return NO;
    float peak = 0;
    for (uint32_t frame = 0; frame < frames; frame++) {
        for (uint32_t outputChannel = 0; outputChannel < 2; outputChannel++) {
            uint32_t sourceChannel = MIN(outputChannel, channels - 1);
            float sample = fmaxf(-1.0f, fminf(1.0f,
                samples[(size_t)frame * channels + sourceChannel]));
            peak = fmaxf(peak, fabsf(sample));
            slot->samples[(size_t)frame * 2 + outputChannel] = CBPCM16(sample);
        }
    }
    [self commitSlot:slot frames:frames sequence:sequence peak:peak];
    return YES;
}

- (BOOL)enqueueAudioBufferList:(const AudioBufferList *)input
                        format:(AudioStreamBasicDescription)format {
    if (!input || input->mNumberBuffers == 0 || format.mFormatID != kAudioFormatLinearPCM
        || !(format.mFormatFlags & kAudioFormatFlagIsFloat) || format.mBitsPerChannel != 32) {
        return NO;
    }
    const uint32_t channels = MAX(format.mChannelsPerFrame, 1);
    const BOOL nonInterleaved = (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;
    uint32_t frames = nonInterleaved
        ? input->mBuffers[0].mDataByteSize / sizeof(float)
        : input->mBuffers[0].mDataByteSize / (sizeof(float) * channels);
    CBPCMSlot *slot;
    uint64_t sequence;
    if (![self reserveFrames:frames slot:&slot sequence:&sequence]) return NO;
    float peak = 0;
    for (uint32_t frame = 0; frame < frames; frame++) {
        for (uint32_t outputChannel = 0; outputChannel < 2; outputChannel++) {
            uint32_t sourceChannel = MIN(outputChannel, channels - 1);
            float sample = 0;
            if (nonInterleaved) {
                uint32_t bufferIndex = MIN(sourceChannel, input->mNumberBuffers - 1);
                const AudioBuffer *buffer = &input->mBuffers[bufferIndex];
                const float *source = buffer->mData;
                if (source && frame < buffer->mDataByteSize / sizeof(float)) sample = source[frame];
            } else {
                const float *source = input->mBuffers[0].mData;
                if (source) sample = source[(size_t)frame * channels + sourceChannel];
            }
            sample = fmaxf(-1.0f, fminf(1.0f, sample));
            peak = fmaxf(peak, fabsf(sample));
            slot->samples[(size_t)frame * 2 + outputChannel] = CBPCM16(sample);
        }
    }
    [self commitSlot:slot frames:frames sequence:sequence peak:peak];
    return YES;
}

- (NSData *)dequeuePacket {
    uint64_t read = atomic_load_explicit(&_readSequence, memory_order_relaxed);
    uint64_t write = atomic_load_explicit(&_writeSequence, memory_order_acquire);
    if (read >= write) return nil;
    CBPCMSlot *slot = &_slots[read % self.slotCount];
    NSData *data = [NSData dataWithBytes:slot->samples
                                  length:(size_t)slot->frameCount * 2 * sizeof(int16_t)];
    atomic_store_explicit(&_readSequence, read + 1, memory_order_release);
    return data;
}

- (uint32_t)queuedPacketCount {
    uint64_t write = atomic_load_explicit(&_writeSequence, memory_order_acquire);
    uint64_t read = atomic_load_explicit(&_readSequence, memory_order_acquire);
    uint64_t count = write - read;
    return count > UINT32_MAX ? UINT32_MAX : (uint32_t)count;
}

- (uint64_t)acceptedFrames {
    return atomic_load_explicit(&_acceptedFramesValue, memory_order_relaxed);
}

- (uint64_t)droppedPackets {
    return atomic_load_explicit(&_droppedPacketsValue, memory_order_relaxed);
}

- (uint64_t)droppedFrames {
    return atomic_load_explicit(&_droppedFramesValue, memory_order_relaxed);
}

- (float)peakLevel {
    uint32_t bits = atomic_load_explicit(&_peakBits, memory_order_relaxed);
    float value;
    memcpy(&value, &bits, sizeof(value));
    return value;
}

- (void)dealloc {
    free(_slots);
    free(_sampleStorage);
}

@end

static uint32_t CBReadUInt32Property(AudioObjectID objectID,
                                     AudioObjectPropertySelector selector) {
    AudioObjectPropertyAddress address = {
        selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
    };
    uint32_t value = 0;
    uint32_t size = sizeof(value);
    if (AudioObjectGetPropertyData(objectID, &address, 0, NULL, &size, &value) != noErr) return 0;
    return value;
}

static NSString *CBReadStringProperty(AudioObjectID objectID,
                                      AudioObjectPropertySelector selector) {
    AudioObjectPropertyAddress address = {
        selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
    };
    CFStringRef value = NULL;
    uint32_t size = sizeof(value);
    if (AudioObjectGetPropertyData(objectID, &address, 0, NULL, &size, &value) != noErr || !value) {
        return @"";
    }
    return CFBridgingRelease(value);
}

static NSError *CBError(OSStatus status, NSString *operation) {
    return [NSError errorWithDomain:CBAudioTapErrorDomain code:status
                           userInfo:@{NSLocalizedDescriptionKey: operation}];
}

@interface CBAudioTap () {
    AudioObjectID _tapID;
    AudioObjectID _aggregateID;
    AudioDeviceIOProcID _ioProcID;
    AudioStreamBasicDescription _format;
    CBAudioPacketHandler _packetHandler;
    CBPCMFrameRing *_ring;
    dispatch_queue_t _drainQueue;
    dispatch_source_t _drainSource;
}
@property(nonatomic, readwrite, getter=isRunning) BOOL running;
@property(nonatomic, readwrite) double sampleRate;
@property(nonatomic, readwrite) uint32_t channelCount;
- (void)handleInput:(const AudioBufferList *)input;
- (void)drainPackets;
@end

static OSStatus CBAudioTapIOProc(AudioObjectID device, const AudioTimeStamp *now,
                                 const AudioBufferList *input, const AudioTimeStamp *inputTime,
                                 AudioBufferList *output, const AudioTimeStamp *outputTime,
                                 void *context) {
    (void)device; (void)now; (void)inputTime; (void)output; (void)outputTime;
    CBAudioTap *tap = (__bridge CBAudioTap *)context;
    if (tap && input && input->mNumberBuffers > 0) [tap handleInput:input];
    return noErr;
}

@implementation CBAudioTap

- (instancetype)init {
    self = [super init];
    if (self) {
        _tapID = kAudioObjectUnknown;
        _aggregateID = kAudioObjectUnknown;
        _ioProcID = NULL;
    }
    return self;
}

- (void)handleInput:(const AudioBufferList *)input {
    if ([_ring enqueueAudioBufferList:input format:_format]) {
        dispatch_source_merge_data(_drainSource, 1);
    }
}

- (void)drainPackets {
    NSData *packet;
    while ((packet = [_ring dequeuePacket])) {
        CBAudioPacketHandler handler = _packetHandler;
        if (handler) handler(packet);
    }
}

- (uint64_t)capturedFrames { return _ring.acceptedFrames; }
- (uint64_t)droppedPackets { return _ring.droppedPackets; }
- (uint64_t)droppedFrames { return _ring.droppedFrames; }
- (float)peakLevel { return _ring.peakLevel; }

+ (NSArray<CBAudioProcessInfo *> *)audioOutputProcesses {
    AudioObjectPropertyAddress address = {
        kAudioHardwarePropertyProcessObjectList,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    uint32_t size = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) != noErr
        || size == 0) return @[];
    AudioObjectID *objects = malloc(size);
    if (!objects) return @[];
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, objects)
        != noErr) {
        free(objects);
        return @[];
    }
    NSMutableArray<CBAudioProcessInfo *> *result = [NSMutableArray array];
    uint32_t count = size / sizeof(AudioObjectID);
    for (uint32_t index = 0; index < count; index++) {
        AudioObjectID objectID = objects[index];
        BOOL isRunningOutput =
            CBReadUInt32Property(objectID, kAudioProcessPropertyIsRunningOutput) != 0;
        pid_t pid = (pid_t)CBReadUInt32Property(objectID, kAudioProcessPropertyPID);
        NSString *bundleID = CBReadStringProperty(objectID, kAudioProcessPropertyBundleID);
        NSRunningApplication *application =
            [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
        NSString *name = application.localizedName;
        if (!name.length) name = bundleID.length ? bundleID : @"Audio process";
        CBAudioProcessInfo *info = [CBAudioProcessInfo new];
        info.objectID = objectID;
        info.processIdentifier = pid;
        info.displayName = name;
        info.bundleIdentifier = bundleID;
        info.isRunningOutput = isRunningOutput;
        [result addObject:info];
    }
    free(objects);
    [result sortUsingComparator:^NSComparisonResult(CBAudioProcessInfo *left,
                                                     CBAudioProcessInfo *right) {
        return [left.displayName localizedCaseInsensitiveCompare:right.displayName];
    }];
    return result;
}

+ (CBAudioProcessInfo *)spotifyOutputProcess {
    for (CBAudioProcessInfo *process in self.audioOutputProcesses) {
        if ([process.bundleIdentifier isEqualToString:CBSpotifyBundleIdentifier]) return process;
    }
    return nil;
}

- (BOOL)startSpotifyWithPacketHandler:(CBAudioPacketHandler)packetHandler
                                error:(NSError **)error {
    CBAudioProcessInfo *spotify = CBAudioTap.spotifyOutputProcess;
    if (!spotify) {
        if (error) *error = [NSError errorWithDomain:CBAudioTapErrorDomain code:-2
            userInfo:@{NSLocalizedDescriptionKey: @"spotify_not_playing"}];
        return NO;
    }
    return [self startProcessObject:spotify.objectID packetHandler:packetHandler error:error];
}

- (BOOL)startProcessObject:(uint32_t)processObjectID
             packetHandler:(CBAudioPacketHandler)packetHandler
                      error:(NSError **)error {
    [self stop];
    _ring = [[CBPCMFrameRing alloc] initWithSlotCount:CBCaptureSlotCount
                                maximumFramesPerSlot:CBCaptureMaximumFrames];
    if (!_ring) {
        if (error) *error = [NSError errorWithDomain:CBAudioTapErrorDomain code:-3
            userInfo:@{NSLocalizedDescriptionKey: @"capture_buffer_unavailable"}];
        return NO;
    }
    _packetHandler = [packetHandler copy];
    _drainQueue = dispatch_queue_create("social.cannabeats.host.audio-drain",
                                        DISPATCH_QUEUE_SERIAL);
    dispatch_queue_set_specific(_drainQueue, &CBAudioDrainQueueKey,
                                &CBAudioDrainQueueKey, NULL);
    _drainSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_DATA_ADD, 0, 0, _drainQueue);
    __weak CBAudioTap *weakSelf = self;
    dispatch_source_set_event_handler(_drainSource, ^{ [weakSelf drainPackets]; });
    dispatch_resume(_drainSource);

    CATapDescription *description = [[CATapDescription alloc]
        initStereoMixdownOfProcesses:@[@(processObjectID)]];
    description.name = @"CannaBeats private Spotify tap";
    description.privateTap = YES;
    description.muteBehavior = CATapMutedWhenTapped;
    OSStatus status = AudioHardwareCreateProcessTap(description, &_tapID);
    if (status != noErr) {
        if (error) *error = CBError(status, @"audio_capture_unavailable");
        [self stop];
        return NO;
    }

    AudioObjectPropertyAddress uidAddress = {
        kAudioTapPropertyUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
    };
    CFStringRef tapUIDValue = NULL;
    uint32_t uidSize = sizeof(tapUIDValue);
    NSString *tapUID = description.UUID.UUIDString;
    status = AudioObjectGetPropertyData(_tapID, &uidAddress, 0, NULL, &uidSize, &tapUIDValue);
    if (status == noErr && tapUIDValue) tapUID = CFBridgingRelease(tapUIDValue);
    NSDictionary *composition = @{
        @kAudioAggregateDeviceNameKey: @"CannaBeats private relay capture",
        @kAudioAggregateDeviceUIDKey: NSUUID.UUID.UUIDString,
        @kAudioAggregateDeviceIsPrivateKey: @YES,
        @kAudioAggregateDeviceIsStackedKey: @NO,
        @kAudioAggregateDeviceTapAutoStartKey: @NO,
        @kAudioAggregateDeviceSubDeviceListKey: @[],
        @kAudioAggregateDeviceTapListKey: @[@{
            @kAudioSubTapUIDKey: tapUID,
            @kAudioSubTapDriftCompensationKey: @YES,
        }],
    };
    status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)composition,
                                                 &_aggregateID);
    if (status != noErr) {
        if (error) *error = CBError(status, @"audio_capture_unavailable");
        [self stop];
        return NO;
    }

    AudioObjectPropertyAddress formatAddress = {
        kAudioDevicePropertyStreamFormat,
        kAudioObjectPropertyScopeInput,
        kAudioObjectPropertyElementMain
    };
    uint32_t formatSize = sizeof(_format);
    status = AudioObjectGetPropertyData(_aggregateID, &formatAddress, 0, NULL,
                                        &formatSize, &_format);
    if (status != noErr || _format.mFormatID != kAudioFormatLinearPCM
        || !(_format.mFormatFlags & kAudioFormatFlagIsFloat)
        || _format.mBitsPerChannel != 32
        || !(_format.mSampleRate == 44100 || _format.mSampleRate == 48000)) {
        if (error) *error = [NSError errorWithDomain:CBAudioTapErrorDomain code:-4
            userInfo:@{NSLocalizedDescriptionKey: @"unsupported_audio_format"}];
        [self stop];
        return NO;
    }
    self.sampleRate = _format.mSampleRate;
    self.channelCount = 2;
    status = AudioDeviceCreateIOProcID(_aggregateID, CBAudioTapIOProc,
                                       (__bridge void *)self, &_ioProcID);
    if (status == noErr) status = AudioDeviceStart(_aggregateID, _ioProcID);
    if (status != noErr) {
        if (error) *error = CBError(status, @"audio_capture_unavailable");
        [self stop];
        return NO;
    }
    self.running = YES;
    return YES;
}

- (void)stop {
    if (_aggregateID != kAudioObjectUnknown && _ioProcID) {
        AudioDeviceStop(_aggregateID, _ioProcID);
        AudioDeviceDestroyIOProcID(_aggregateID, _ioProcID);
    }
    _ioProcID = NULL;
    if (_aggregateID != kAudioObjectUnknown) {
        AudioHardwareDestroyAggregateDevice(_aggregateID);
        _aggregateID = kAudioObjectUnknown;
    }
    if (_tapID != kAudioObjectUnknown) {
        AudioHardwareDestroyProcessTap(_tapID);
        _tapID = kAudioObjectUnknown;
    }
    if (_drainSource) {
        dispatch_source_cancel(_drainSource);
        if (_drainQueue && !dispatch_get_specific(&CBAudioDrainQueueKey)) {
            dispatch_sync(_drainQueue, ^{});
        }
    }
    _drainSource = nil;
    _drainQueue = nil;
    _packetHandler = nil;
    _ring = nil;
    self.running = NO;
    self.sampleRate = 0;
    self.channelCount = 0;
}

- (void)dealloc { [self stop]; }

@end
