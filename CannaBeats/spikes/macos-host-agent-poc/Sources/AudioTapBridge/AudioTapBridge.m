#import "AudioTapBridge.h"

#import <AppKit/AppKit.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>

#include <math.h>
#include <stdatomic.h>

static NSString *const CBAudioTapErrorDomain = @"social.cannabeats.host.audio-tap";

@interface CBAudioProcessInfo ()
@property(nonatomic, readwrite) uint32_t objectID;
@property(nonatomic, readwrite) pid_t processIdentifier;
@property(nonatomic, readwrite, copy) NSString *displayName;
@property(nonatomic, readwrite, copy) NSString *bundleIdentifier;
@property(nonatomic, readwrite) BOOL isRunningOutput;
@end

@implementation CBAudioProcessInfo
@end

static UInt32 CBReadUInt32Property(AudioObjectID objectID,
                                   AudioObjectPropertySelector selector) {
    AudioObjectPropertyAddress address = {
        selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
    };
    UInt32 value = 0;
    UInt32 size = sizeof(value);
    if (AudioObjectGetPropertyData(objectID, &address, 0, NULL, &size, &value) != noErr) {
        return 0;
    }
    return value;
}

static NSString *CBReadStringProperty(AudioObjectID objectID,
                                      AudioObjectPropertySelector selector) {
    AudioObjectPropertyAddress address = {
        selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
    };
    CFStringRef value = NULL;
    UInt32 size = sizeof(value);
    if (AudioObjectGetPropertyData(objectID, &address, 0, NULL, &size, &value) != noErr || !value) {
        return @"";
    }
    return CFBridgingRelease(value);
}

static NSError *CBError(OSStatus status, NSString *operation) {
    UInt32 bigEndian = CFSwapInt32HostToBig((UInt32)status);
    unsigned char *bytes = (unsigned char *)&bigEndian;
    NSString *code;
    if (isprint(bytes[0]) && isprint(bytes[1]) && isprint(bytes[2]) && isprint(bytes[3])) {
        code = [NSString stringWithFormat:@"'%c%c%c%c'", bytes[0], bytes[1], bytes[2], bytes[3]];
    } else {
        code = [NSString stringWithFormat:@"%d", (int)status];
    }
    return [NSError errorWithDomain:CBAudioTapErrorDomain
                               code:status
                           userInfo:@{NSLocalizedDescriptionKey:
                                          [NSString stringWithFormat:@"%@ failed (%@).", operation, code]}];
}

@interface CBAudioTap () {
    AudioObjectID _tapID;
    AudioObjectID _aggregateID;
    AudioDeviceIOProcID _ioProcID;
    AudioStreamBasicDescription _format;
    CBAudioPacketHandler _packetHandler;
    _Atomic uint64_t _capturedFramesValue;
    _Atomic uint32_t _peakBits;
}
@property(nonatomic, readwrite, getter=isRunning) BOOL running;
@property(nonatomic, readwrite) double sampleRate;
@property(nonatomic, readwrite) uint32_t channelCount;
- (void)handleInput:(const AudioBufferList *)input;
@end

static OSStatus CBAudioTapIOProc(AudioObjectID device,
                                 const AudioTimeStamp *now,
                                 const AudioBufferList *input,
                                 const AudioTimeStamp *inputTime,
                                 AudioBufferList *output,
                                 const AudioTimeStamp *outputTime,
                                 void *context) {
    (void)device;
    (void)now;
    (void)inputTime;
    (void)output;
    (void)outputTime;
    CBAudioTap *tap = (__bridge CBAudioTap *)context;
    if (!tap || !input || input->mNumberBuffers == 0) return noErr;

    [tap handleInput:input];
    return noErr;
}

@implementation CBAudioTap

- (void)handleInput:(const AudioBufferList *)input {

    const AudioStreamBasicDescription format = _format;
    if (format.mFormatID != kAudioFormatLinearPCM ||
        !(format.mFormatFlags & kAudioFormatFlagIsFloat) ||
        format.mBitsPerChannel != 32) {
        return;
    }

    const UInt32 sourceChannels = MAX(format.mChannelsPerFrame, 1);
    const BOOL nonInterleaved = (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;
    UInt32 frames;
    if (nonInterleaved) {
        frames = input->mBuffers[0].mDataByteSize / sizeof(float);
    } else {
        frames = input->mBuffers[0].mDataByteSize / (sizeof(float) * sourceChannels);
    }
    if (frames == 0) return;

    NSMutableData *pcm = [[NSMutableData alloc]
        initWithLength:(NSUInteger)frames * 2 * sizeof(int16_t)];
    int16_t *destination = pcm.mutableBytes;
    float peak = 0;
    for (UInt32 frame = 0; frame < frames; frame++) {
        for (UInt32 outputChannel = 0; outputChannel < 2; outputChannel++) {
            UInt32 sourceChannel = MIN(outputChannel, sourceChannels - 1);
            float sample = 0;
            if (nonInterleaved) {
                UInt32 bufferIndex = MIN(sourceChannel, input->mNumberBuffers - 1);
                const float *source = input->mBuffers[bufferIndex].mData;
                if (source && frame < input->mBuffers[bufferIndex].mDataByteSize / sizeof(float)) {
                    sample = source[frame];
                }
            } else {
                const float *source = input->mBuffers[0].mData;
                if (source) sample = source[frame * sourceChannels + sourceChannel];
            }
            sample = fmaxf(-1.0f, fminf(1.0f, sample));
            peak = fmaxf(peak, fabsf(sample));
            destination[frame * 2 + outputChannel] = (int16_t)lrintf(sample * 32767.0f);
        }
    }

    atomic_fetch_add_explicit(&_capturedFramesValue, frames, memory_order_relaxed);
    uint32_t oldBits;
    uint32_t newBits;
    do {
        oldBits = atomic_load_explicit(&_peakBits, memory_order_relaxed);
        float previous;
        memcpy(&previous, &oldBits, sizeof(previous));
        float next = MAX(peak, previous * 0.92f);
        memcpy(&newBits, &next, sizeof(newBits));
    } while (!atomic_compare_exchange_weak_explicit(
        &_peakBits, &oldBits, newBits, memory_order_relaxed, memory_order_relaxed
    ));
    CBAudioPacketHandler handler = _packetHandler;
    if (handler) handler(pcm);
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _tapID = kAudioObjectUnknown;
        _aggregateID = kAudioObjectUnknown;
        _ioProcID = NULL;
    }
    return self;
}

- (uint64_t)capturedFrames {
    return atomic_load_explicit(&_capturedFramesValue, memory_order_relaxed);
}

- (float)peakLevel {
    uint32_t bits = atomic_load_explicit(&_peakBits, memory_order_relaxed);
    float value;
    memcpy(&value, &bits, sizeof(value));
    return value;
}

+ (NSArray<CBAudioProcessInfo *> *)audioOutputProcesses {
    AudioObjectPropertyAddress address = {
        kAudioHardwarePropertyProcessObjectList,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) != noErr ||
        size == 0) {
        return @[];
    }
    AudioObjectID *objects = malloc(size);
    if (!objects) return @[];
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, objects) != noErr) {
        free(objects);
        return @[];
    }

    NSMutableArray<CBAudioProcessInfo *> *result = [NSMutableArray array];
    UInt32 count = size / sizeof(AudioObjectID);
    for (UInt32 index = 0; index < count; index++) {
        AudioObjectID objectID = objects[index];
        if (!CBReadUInt32Property(objectID, kAudioProcessPropertyIsRunningOutput)) continue;
        pid_t pid = (pid_t)CBReadUInt32Property(objectID, kAudioProcessPropertyPID);
        NSString *bundleID = CBReadStringProperty(objectID, kAudioProcessPropertyBundleID);
        NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
        NSString *name = application.localizedName;
        if (!name.length) name = bundleID.length ? bundleID : [NSString stringWithFormat:@"Audio process %d", pid];

        CBAudioProcessInfo *info = [CBAudioProcessInfo new];
        info.objectID = objectID;
        info.processIdentifier = pid;
        info.displayName = name;
        info.bundleIdentifier = bundleID;
        info.isRunningOutput = YES;
        [result addObject:info];
    }
    free(objects);
    [result sortUsingComparator:^NSComparisonResult(CBAudioProcessInfo *left, CBAudioProcessInfo *right) {
        return [left.displayName localizedCaseInsensitiveCompare:right.displayName];
    }];
    return result;
}

- (BOOL)startProcessObject:(uint32_t)processObjectID
             packetHandler:(CBAudioPacketHandler)packetHandler
                      error:(NSError **)error {
    [self stop];
    _packetHandler = [packetHandler copy];
    atomic_store_explicit(&_capturedFramesValue, 0, memory_order_relaxed);
    atomic_store_explicit(&_peakBits, 0, memory_order_relaxed);

    CATapDescription *description = [[CATapDescription alloc]
        initStereoMixdownOfProcesses:@[@(processObjectID)]];
    description.name = @"CannaBeats private host tap";
    description.privateTap = YES;
    description.muteBehavior = CATapMutedWhenTapped;

    OSStatus status = AudioHardwareCreateProcessTap(description, &_tapID);
    if (status != noErr) {
        if (error) *error = CBError(status, @"Creating the Spotify process tap");
        [self stop];
        return NO;
    }

    AudioObjectPropertyAddress uidAddress = {
        kAudioTapPropertyUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
    };
    CFStringRef tapUIDValue = NULL;
    UInt32 uidSize = sizeof(tapUIDValue);
    NSString *tapUID = description.UUID.UUIDString;
    status = AudioObjectGetPropertyData(_tapID, &uidAddress, 0, NULL, &uidSize, &tapUIDValue);
    if (status == noErr && tapUIDValue) tapUID = CFBridgingRelease(tapUIDValue);

    NSString *aggregateUID = NSUUID.UUID.UUIDString;
    NSDictionary *composition = @{
        @kAudioAggregateDeviceNameKey: @"CannaBeats private relay capture",
        @kAudioAggregateDeviceUIDKey: aggregateUID,
        @kAudioAggregateDeviceIsPrivateKey: @YES,
        @kAudioAggregateDeviceIsStackedKey: @NO,
        @kAudioAggregateDeviceTapAutoStartKey: @NO,
        @kAudioAggregateDeviceSubDeviceListKey: @[],
        @kAudioAggregateDeviceTapListKey: @[@{
            @kAudioSubTapUIDKey: tapUID,
            @kAudioSubTapDriftCompensationKey: @YES,
        }],
    };
    status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)composition, &_aggregateID);
    if (status != noErr) {
        if (error) *error = CBError(status, @"Creating the private tap device");
        [self stop];
        return NO;
    }

    AudioObjectPropertyAddress formatAddress = {
        kAudioDevicePropertyStreamFormat,
        kAudioObjectPropertyScopeInput,
        kAudioObjectPropertyElementMain
    };
    UInt32 formatSize = sizeof(_format);
    status = AudioObjectGetPropertyData(
        _aggregateID, &formatAddress, 0, NULL, &formatSize, &_format
    );
    if (status != noErr || _format.mFormatID != kAudioFormatLinearPCM ||
        !(_format.mFormatFlags & kAudioFormatFlagIsFloat) || _format.mBitsPerChannel != 32) {
        if (error) *error = status == noErr
            ? [NSError errorWithDomain:CBAudioTapErrorDomain code:-1
                               userInfo:@{NSLocalizedDescriptionKey:
                                              @"The process tap did not expose 32-bit floating-point PCM."}]
            : CBError(status, @"Reading the process-tap format");
        [self stop];
        return NO;
    }
    self.sampleRate = _format.mSampleRate;
    self.channelCount = 2;

    status = AudioDeviceCreateIOProcID(_aggregateID, CBAudioTapIOProc,
                                       (__bridge void *)self, &_ioProcID);
    if (status == noErr) status = AudioDeviceStart(_aggregateID, _ioProcID);
    if (status != noErr) {
        if (error) *error = CBError(status, @"Starting process audio capture");
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
    _packetHandler = nil;
    self.running = NO;
}

- (void)dealloc {
    [self stop];
}

@end
