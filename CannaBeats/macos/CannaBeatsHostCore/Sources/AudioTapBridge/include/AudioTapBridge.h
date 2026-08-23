#import <AudioToolbox/AudioToolbox.h>
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSErrorDomain const CBAudioTapErrorDomain;

@interface CBAudioProcessInfo : NSObject

@property(nonatomic, readonly) uint32_t objectID;
@property(nonatomic, readonly) pid_t processIdentifier;
@property(nonatomic, readonly, copy) NSString *displayName;
@property(nonatomic, readonly, copy) NSString *bundleIdentifier;
@property(nonatomic, readonly) BOOL isRunningOutput;

@end

@interface CBPCMFrameRing : NSObject

@property(nonatomic, readonly) uint32_t slotCount;
@property(nonatomic, readonly) uint32_t maximumFramesPerSlot;
@property(nonatomic, readonly) uint32_t queuedPacketCount;
@property(nonatomic, readonly) uint64_t acceptedFrames;
@property(nonatomic, readonly) uint64_t droppedPackets;
@property(nonatomic, readonly) uint64_t droppedFrames;
@property(nonatomic, readonly) float peakLevel;

- (nullable instancetype)initWithSlotCount:(uint32_t)slotCount
                      maximumFramesPerSlot:(uint32_t)maximumFramesPerSlot;

// Producer-side methods perform no allocation and never wait. The caller must
// supply valid storage for frames * channels float samples.
- (BOOL)enqueueInterleavedFloatSamples:(const float *)samples
                                frames:(uint32_t)frames
                              channels:(uint32_t)channels;
- (BOOL)enqueueAudioBufferList:(const AudioBufferList *)input
                        format:(AudioStreamBasicDescription)format;

// Consumer-side dequeue copies one retained packet and may allocate NSData.
- (nullable NSData *)dequeuePacket;

@end

typedef void (^CBAudioPacketHandler)(NSData *pcmData);

@interface CBAudioTap : NSObject

@property(nonatomic, readonly, getter=isRunning) BOOL running;
@property(nonatomic, readonly) double sampleRate;
@property(nonatomic, readonly) uint32_t channelCount;
@property(nonatomic, readonly) uint64_t capturedFrames;
@property(nonatomic, readonly) uint64_t droppedPackets;
@property(nonatomic, readonly) uint64_t droppedFrames;
@property(nonatomic, readonly) float peakLevel;

+ (NSArray<CBAudioProcessInfo *> *)audioOutputProcesses;
+ (nullable CBAudioProcessInfo *)spotifyOutputProcess;

- (BOOL)startSpotifyWithPacketHandler:(CBAudioPacketHandler)packetHandler
                                error:(NSError **)error;
- (BOOL)startProcessObject:(uint32_t)processObjectID
             packetHandler:(CBAudioPacketHandler)packetHandler
                      error:(NSError **)error;
- (void)stop;
- (BOOL)stopAndReturnError:(NSError **)error NS_SWIFT_NAME(stopChecked());

@end

NS_ASSUME_NONNULL_END
