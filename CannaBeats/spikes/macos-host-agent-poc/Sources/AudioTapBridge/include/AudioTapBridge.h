#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface CBAudioProcessInfo : NSObject

@property(nonatomic, readonly) uint32_t objectID;
@property(nonatomic, readonly) pid_t processIdentifier;
@property(nonatomic, readonly, copy) NSString *displayName;
@property(nonatomic, readonly, copy) NSString *bundleIdentifier;
@property(nonatomic, readonly) BOOL isRunningOutput;

@end

typedef void (^CBAudioPacketHandler)(NSData *pcmData);

@interface CBAudioTap : NSObject

@property(nonatomic, readonly, getter=isRunning) BOOL running;
@property(nonatomic, readonly) double sampleRate;
@property(nonatomic, readonly) uint32_t channelCount;
@property(nonatomic, readonly) uint64_t capturedFrames;
@property(nonatomic, readonly) float peakLevel;

+ (NSArray<CBAudioProcessInfo *> *)audioOutputProcesses;

- (BOOL)startProcessObject:(uint32_t)processObjectID
             packetHandler:(CBAudioPacketHandler)packetHandler
                      error:(NSError **)error;
- (void)stop;

@end

NS_ASSUME_NONNULL_END
