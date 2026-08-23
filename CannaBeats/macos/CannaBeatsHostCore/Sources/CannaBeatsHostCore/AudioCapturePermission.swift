import Foundation

public enum AudioCaptureReadiness: String, Equatable, Sendable {
    case unsupported
    case notDetermined = "not_determined"
    case ready
    case failed
}

public protocol AudioCaptureAuthorizing: Sendable {
    func readiness() -> AudioCaptureReadiness
    func prepareCaptureAttempt() -> AudioCaptureReadiness
    func recordCaptureResult(_ result: AudioCaptureReadiness)
}

public final class SystemAudioCapturePermission: AudioCaptureAuthorizing, @unchecked Sendable {
    private let lock = NSLock()
    private let supported: @Sendable () -> Bool
    private let loadResult: @Sendable () -> AudioCaptureReadiness?
    private let saveResult: @Sendable (AudioCaptureReadiness) -> Void
    private let probe: @Sendable () throws -> Void
    private var probeTask: Task<AudioCaptureReadiness, Never>?
    private var probeGeneration: UInt64 = 0

    public init(
        supported: @escaping @Sendable () -> Bool = {
            if #available(macOS 14.2, *) { return true }
            return false
        },
        loadResult: @escaping @Sendable () -> AudioCaptureReadiness? = {
            UserDefaults.standard.string(
                forKey: "social.cannabeats.host.audio-capture-result"
            ).flatMap(AudioCaptureReadiness.init(rawValue:))
        },
        saveResult: @escaping @Sendable (AudioCaptureReadiness) -> Void = {
            UserDefaults.standard.set(
                $0.rawValue, forKey: "social.cannabeats.host.audio-capture-result"
            )
        },
        probe: (@Sendable () throws -> Void)? = nil
    ) {
        self.supported = supported
        self.loadResult = loadResult
        self.saveResult = saveResult
        self.probe = probe ?? Self.makeDefaultProbe()
    }

    public func readiness() -> AudioCaptureReadiness {
        lock.lock()
        defer { lock.unlock() }
        return readinessLocked()
    }

    public func prepareCaptureAttempt() -> AudioCaptureReadiness {
        lock.lock()
        defer { lock.unlock() }
        return supported() ? .ready : .unsupported
    }

    public func recordCaptureResult(_ result: AudioCaptureReadiness) {
        guard result == .ready || result == .failed else { return }
        lock.lock()
        saveResult(result)
        lock.unlock()
    }

    /// Starts and immediately tears down the real private Spotify tap. Core Audio
    /// presents System Audio Recording consent only when tap-backed recording starts;
    /// it does not expose a separate permission-request API.
    public func requestReadiness() async -> AudioCaptureReadiness {
        let prepared = lock.withLock {
            () -> (Task<AudioCaptureReadiness, Never>, UInt64)? in
            guard supported() else { return nil }
            if let existing = probeTask {
                return (existing, probeGeneration)
            } else {
                probeGeneration &+= 1
                let task = Task.detached { [probe] () -> AudioCaptureReadiness in
                    do {
                        try probe()
                        return .ready
                    } catch {
                        return .failed
                    }
                }
                probeTask = task
                return (task, probeGeneration)
            }
        }
        guard let (task, generation) = prepared else { return .unsupported }

        let result = await task.value
        lock.withLock {
            guard probeGeneration == generation, probeTask != nil else { return }
            saveResult(result)
            probeTask = nil
        }
        return result
    }

    private static func makeDefaultProbe() -> @Sendable () throws -> Void {
        let probe = SpotifyCapturePermissionProbe()
        return { try probe.run() }
    }

    private func readinessLocked() -> AudioCaptureReadiness {
        guard supported() else { return .unsupported }
        return loadResult() ?? .notDetermined
    }
}

private final class SpotifyCapturePermissionProbe: @unchecked Sendable {
    private var retainedCapture: SpotifyProcessCapture?

    func run() throws {
        if let retainedCapture {
            try retainedCapture.stopChecked()
            self.retainedCapture = nil
        }
        let capture = SpotifyProcessCapture()
        do {
            try capture.start { _ in }
            try capture.stopChecked()
        } catch {
            do {
                try capture.stopChecked()
            } catch {
                retainedCapture = capture
            }
            throw error
        }
    }
}
