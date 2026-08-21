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
        }
    ) {
        self.supported = supported
        self.loadResult = loadResult
        self.saveResult = saveResult
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

    private func readinessLocked() -> AudioCaptureReadiness {
        guard supported() else { return .unsupported }
        return loadResult() ?? .notDetermined
    }
}
