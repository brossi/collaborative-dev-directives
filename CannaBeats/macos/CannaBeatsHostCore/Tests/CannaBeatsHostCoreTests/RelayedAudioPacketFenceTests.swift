import Dispatch
import Testing
@testable import CannaBeatsHostCore

@Test func retireReleasesPacketLockBeforeSynchronousHardwareCompletion() {
    let fence = RelayedAudioPacketFence()
    fence.begin()
    let token = fence.reserve(frames: 480, maximum: 64)!
    let completed = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
        fence.retire {
            // AVAudioPlayerNode.stop() may synchronously wait for this callback.
            fence.complete(token)
        }
        completed.signal()
    }
    #expect(completed.wait(timeout: .now() + 1) == .success)
    #expect(fence.queuedPackets == 0)
}

@Test func lateCompletionCannotMutateReplacementGeneration() {
    let fence = RelayedAudioPacketFence()
    fence.begin()
    let retired = fence.reserve(frames: 480, maximum: 64)!
    fence.retire {}
    fence.begin()
    let replacement = fence.reserve(frames: 480, maximum: 64)!

    fence.complete(retired)
    #expect(fence.queuedPackets == 1)
    fence.complete(replacement)
    #expect(fence.queuedPackets == 0)
}

@Test func packetCapacityAcceptsMaxMinusOneAndMaxButDropsMaxPlusOne() {
    let fence = RelayedAudioPacketFence()
    fence.begin()
    for _ in 0..<(RelayedAudioPlayer.maximumScheduledPackets - 1) {
        #expect(fence.reserve(frames: 480, maximum: 64) != nil)
    }
    #expect(fence.queuedPackets == 63)
    #expect(fence.reserve(frames: 480, maximum: 64) != nil)
    #expect(fence.queuedPackets == 64)
    #expect(fence.reserve(frames: 480, maximum: 64) == nil)
    #expect(fence.queuedPackets == 64)
    #expect(fence.droppedPackets == 1)
    #expect(fence.droppedFrames == 480)
}

@Test func repeatedRetireIsFiniteAndIdempotent() {
    let fence = RelayedAudioPacketFence()
    fence.begin()
    _ = fence.reserve(frames: 480, maximum: 64)
    let completed = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
        for _ in 0..<1_000 { fence.retire {} }
        completed.signal()
    }
    #expect(completed.wait(timeout: .now() + 1) == .success)
    #expect(fence.queuedPackets == 0)
}
