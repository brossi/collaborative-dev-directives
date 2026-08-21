import AVFoundation
import Foundation

public final class RelayedAudioPlayer: @unchecked Sendable {
    public static let maximumScheduledPackets = 64

    private let lock = NSLock()
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private var format: AVAudioFormat?
    private var generation: UInt64 = 0
    private var scheduledPackets = 0
    private var droppedPacketCount: UInt64 = 0
    private var droppedFrameCount: UInt64 = 0

    public init() {}

    public func start(sampleRate: Int) throws {
        guard [44_100, 48_000].contains(sampleRate),
              let format = AVAudioFormat(
                standardFormatWithSampleRate: Double(sampleRate), channels: 2
              ) else { throw SharedAudioFailure.invalidFormat }
        lock.lock()
        defer { lock.unlock() }
        stopLocked()
        self.format = format
        generation &+= 1
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        do {
            try engine.start()
            node.play()
        } catch {
            stopLocked()
            throw SharedAudioFailure.unavailable
        }
    }

    @discardableResult
    public func append(interleavedInt16 data: Data) -> Bool {
        guard !data.isEmpty, data.count <= 64 * 1_024, data.count.isMultiple(of: 4) else {
            return false
        }
        lock.lock()
        guard let format, engine.isRunning,
              scheduledPackets < Self.maximumScheduledPackets else {
            droppedPacketCount += 1
            droppedFrameCount += UInt64(data.count / 4)
            lock.unlock()
            return false
        }
        let frameCount = data.count / 4
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format, frameCapacity: AVAudioFrameCount(frameCount)
        ), let destination = buffer.floatChannelData else {
            lock.unlock()
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
        scheduledPackets += 1
        let retainedGeneration = generation
        node.scheduleBuffer(
            buffer, completionCallbackType: .dataPlayedBack
        ) { [weak self] _ in
            guard let self else { return }
            self.lock.lock()
            if self.generation == retainedGeneration, self.scheduledPackets > 0 {
                self.scheduledPackets -= 1
            }
            self.lock.unlock()
        }
        lock.unlock()
        return true
    }

    public func stop() {
        lock.lock()
        stopLocked()
        lock.unlock()
    }

    public var queuedPackets: Int {
        lock.lock()
        defer { lock.unlock() }
        return scheduledPackets
    }

    public var droppedPackets: UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return droppedPacketCount
    }

    public var droppedFrames: UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return droppedFrameCount
    }

    private func stopLocked() {
        generation &+= 1
        scheduledPackets = 0
        if node.engine != nil {
            node.stop()
            engine.stop()
            engine.disconnectNodeOutput(node)
            engine.detach(node)
        }
        format = nil
    }

    deinit { stop() }
}
