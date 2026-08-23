import AVFoundation
import Foundation

package final class RelayedAudioPacketFence: @unchecked Sendable {
    package struct Token: Equatable, Sendable { fileprivate let generation: UInt64 }

    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var scheduledPackets = 0
    private var droppedPacketCount: UInt64 = 0
    private var droppedFrameCount: UInt64 = 0

    package init() {}

    package func begin() {
        lock.withLock {
            generation &+= 1
            scheduledPackets = 0
        }
    }

    package func reserve(frames: Int, maximum: Int) -> Token? {
        lock.withLock {
            guard scheduledPackets < maximum else {
                droppedPacketCount += 1
                droppedFrameCount += UInt64(frames)
                return nil
            }
            scheduledPackets += 1
            return Token(generation: generation)
        }
    }

    package func drop(frames: Int) {
        lock.withLock {
            droppedPacketCount += 1
            droppedFrameCount += UInt64(frames)
        }
    }

    package func complete(_ token: Token) {
        lock.withLock {
            if generation == token.generation, scheduledPackets > 0 {
                scheduledPackets -= 1
            }
        }
    }

    package func retire(then teardown: () -> Void) {
        lock.withLock {
            generation &+= 1
            scheduledPackets = 0
        }
        teardown()
    }

    package var queuedPackets: Int { lock.withLock { scheduledPackets } }
    package var droppedPackets: UInt64 { lock.withLock { droppedPacketCount } }
    package var droppedFrames: UInt64 { lock.withLock { droppedFrameCount } }
}

public final class RelayedAudioPlayer: @unchecked Sendable {
    public static let maximumScheduledPackets = 64

    // AVFoundation lifecycle calls are serialized separately from packet state.
    // Scheduled-buffer callbacks take only the packet fence, so node.stop()
    // cannot wait on a callback that is waiting for a lock held by stop().
    private let lifecycleLock = NSLock()
    private let packets = RelayedAudioPacketFence()
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private var format: AVAudioFormat?

    public init() {}

    public func start(sampleRate: Int) throws {
        guard [44_100, 48_000].contains(sampleRate),
              let format = AVAudioFormat(
                standardFormatWithSampleRate: Double(sampleRate), channels: 2
              ) else { throw SharedAudioFailure.invalidFormat }
        lifecycleLock.lock()
        defer { lifecycleLock.unlock() }
        stopHardwareLocked()
        self.format = format
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        do {
            try engine.start()
            node.play()
            packets.begin()
        } catch {
            stopHardwareLocked()
            throw SharedAudioFailure.unavailable
        }
    }

    @discardableResult
    public func append(interleavedInt16 data: Data) -> Bool {
        guard !data.isEmpty, data.count <= 64 * 1_024, data.count.isMultiple(of: 4) else {
            return false
        }
        lifecycleLock.lock()
        defer { lifecycleLock.unlock() }
        guard let format, engine.isRunning else {
            packets.drop(frames: data.count / 4)
            return false
        }
        let frameCount = data.count / 4
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format, frameCapacity: AVAudioFrameCount(frameCount)
        ), let destination = buffer.floatChannelData else {
            return false
        }
        buffer.frameLength = AVAudioFrameCount(frameCount)
        data.withUnsafeBytes { bytes in
            let samples = bytes.bindMemory(to: Int16.self)
            for frame in 0..<frameCount {
                destination[0][frame] = Float(samples[frame * 2]) / 32_768.0
                destination[1][frame] = Float(samples[frame * 2 + 1]) / 32_768.0
            }
        }
        guard let token = packets.reserve(
            frames: frameCount, maximum: Self.maximumScheduledPackets
        ) else { return false }
        node.scheduleBuffer(
            buffer, completionCallbackType: .dataPlayedBack
        ) { [weak self] _ in
            self?.packets.complete(token)
        }
        return true
    }

    public func stop() {
        lifecycleLock.withLock { stopHardwareLocked() }
    }

    public var queuedPackets: Int { packets.queuedPackets }

    public var droppedPackets: UInt64 { packets.droppedPackets }

    public var droppedFrames: UInt64 { packets.droppedFrames }

    private func stopHardwareLocked() {
        format = nil
        packets.retire {
            if node.engine != nil {
                node.stop()
                engine.stop()
                engine.disconnectNodeOutput(node)
                engine.detach(node)
            }
        }
    }

    deinit { stop() }
}
