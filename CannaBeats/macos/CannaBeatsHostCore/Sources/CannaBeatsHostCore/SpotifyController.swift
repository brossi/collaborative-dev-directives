import AppKit
import Foundation

public enum SpotifyApplicationState: Equatable, Sendable {
    case missing
    case notRunning
    case running
}

public enum SpotifyPlayerState: String, Codable, Equatable, Sendable {
    case playing
    case paused
    case stopped
}

public struct SpotifyReadback: Codable, Equatable, Sendable {
    public let playerState: SpotifyPlayerState
    public let positionMilliseconds: Int64
    public let trackUri: String?

    public init(
        playerState: SpotifyPlayerState,
        positionMilliseconds: Int64,
        trackUri: String?
    ) {
        self.playerState = playerState
        self.positionMilliseconds = positionMilliseconds
        self.trackUri = trackUri
    }

    enum CodingKeys: String, CodingKey {
        case playerState, positionMilliseconds, trackUri
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(playerState, forKey: .playerState)
        try container.encode(positionMilliseconds, forKey: .positionMilliseconds)
        if let trackUri { try container.encode(trackUri, forKey: .trackUri) }
        else { try container.encodeNil(forKey: .trackUri) }
    }
}

public enum SpotifyControllerFailure: String, Codable, Error, Equatable, Sendable {
    case spotifyMissing = "spotify_missing"
    case spotifyNotRunning = "spotify_not_running"
    case spotifySignedOut = "spotify_signed_out"
    case automationDenied = "automation_denied"
    case commandTimeout = "command_timeout"
    case unexpectedTrack = "unexpected_track"
    case responseLost = "response_lost"
    case unrecognized
}

public enum SpotifyControllerResult<Value: Sendable>: Sendable {
    case success(Value)
    case failure(SpotifyControllerFailure)
}

extension SpotifyControllerResult: Equatable where Value: Equatable {}

@MainActor
public protocol SpotifyControlling: AnyObject {
    func applicationState() -> SpotifyApplicationState
    func readback() async -> SpotifyControllerResult<SpotifyReadback>
    func playTrack(uri: String) async -> SpotifyControllerResult<Void>
    func play() async -> SpotifyControllerResult<Void>
    func pause() async -> SpotifyControllerResult<Void>
}

@MainActor
public final class AppleEventSpotifyController: SpotifyControlling {
    public static let spotifyBundleIdentifier = "com.spotify.client"

    private let timeout: Duration
    private let executeScript: @Sendable (String) -> SpotifyControllerResult<String>
    private static var pendingExecution: Task<SpotifyControllerResult<String>, Never>?

    public init(timeout: Duration = .seconds(3)) {
        self.timeout = timeout
        self.executeScript = Self.execute
    }

    package init(
        timeout: Duration,
        executeScript: @escaping @Sendable (String) -> SpotifyControllerResult<String>
    ) {
        self.timeout = timeout
        self.executeScript = executeScript
    }

    public func applicationState() -> SpotifyApplicationState {
        guard NSWorkspace.shared.urlForApplication(
            withBundleIdentifier: Self.spotifyBundleIdentifier
        ) != nil else { return .missing }
        return NSRunningApplication.runningApplications(
            withBundleIdentifier: Self.spotifyBundleIdentifier
        ).isEmpty ? .notRunning : .running
    }

    public func readback() async -> SpotifyControllerResult<SpotifyReadback> {
        switch applicationState() {
        case .missing: return .failure(.spotifyMissing)
        case .notRunning: return .failure(.spotifyNotRunning)
        case .running: break
        }
        let script = #"""
        tell application id "com.spotify.client"
            set stateText to (player state as text)
            if stateText is "stopped" then return stateText & "|||" & "" & "|||0"
            set uriText to (spotify url of current track)
            set positionText to (player position as text)
            return stateText & "|||" & uriText & "|||" & positionText
        end tell
        """#
        switch await run(script) {
        case .failure(let failure): return .failure(failure)
        case .success(let value):
            let fields = value.components(separatedBy: "|||")
            guard fields.count == 3,
                  let state = SpotifyPlayerState(rawValue: fields[0]),
                  let seconds = Double(fields[2]), seconds.isFinite, seconds >= 0,
                  seconds <= Double(Int64.max) / 1_000 else {
                return .failure(.unrecognized)
            }
            let uri = fields[1].isEmpty ? nil : fields[1]
            guard uri == nil || Self.validTrackURI(uri!) else {
                return .failure(.unrecognized)
            }
            return .success(SpotifyReadback(
                playerState: state,
                positionMilliseconds: Int64((seconds * 1_000).rounded()),
                trackUri: uri
            ))
        }
    }

    public func playTrack(uri: String) async -> SpotifyControllerResult<Void> {
        guard Self.validTrackURI(uri) else { return .failure(.unrecognized) }
        return withoutOutput(await run(#"tell application id "com.spotify.client" to play track "\#(uri)""#))
    }

    public func play() async -> SpotifyControllerResult<Void> {
        withoutOutput(await run(#"tell application id "com.spotify.client" to play"#))
    }

    public func pause() async -> SpotifyControllerResult<Void> {
        withoutOutput(await run(#"tell application id "com.spotify.client" to pause"#))
    }

    private static func validTrackURI(_ value: String) -> Bool {
        value.range(
            of: #"^spotify:track:[0-9A-Za-z]{22}$"#,
            options: .regularExpression
        ) != nil
    }

    private func withoutOutput(
        _ result: SpotifyControllerResult<String>
    ) -> SpotifyControllerResult<Void> {
        switch result {
        case .success: .success(())
        case .failure(let failure): .failure(failure)
        }
    }

    private func run(_ source: String) async -> SpotifyControllerResult<String> {
        let predecessor = Self.pendingExecution
        let executeScript = self.executeScript
        let execution = Task.detached {
            if let predecessor { _ = await predecessor.value }
            return executeScript(source)
        }
        Self.pendingExecution = execution
        return await withCheckedContinuation { continuation in
            let gate = OneShot(continuation)
            Task {
                gate.resolve(await execution.value)
            }
            Task.detached { [timeout] in
                try? await Task.sleep(for: timeout)
                gate.resolve(.failure(.commandTimeout))
            }
        }
    }

    nonisolated private static func execute(
        _ source: String
    ) -> SpotifyControllerResult<String> {
        var error: NSDictionary?
        let result = NSAppleScript(source: source)?.executeAndReturnError(&error)
        if let error {
            let number = error[NSAppleScript.errorNumber] as? Int ?? 0
            switch number {
            case -1743: return .failure(.automationDenied)
            case -600: return .failure(.spotifyNotRunning)
            case -1728, -10000: return .failure(.spotifySignedOut)
            default: return .failure(.unrecognized)
            }
        }
        guard let result else { return .failure(.unrecognized) }
        return .success(result.stringValue ?? "")
    }
}

private final class OneShot<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Never>?

    init(_ continuation: CheckedContinuation<Value, Never>) {
        self.continuation = continuation
    }

    func resolve(_ value: Value) {
        let retained = lock.withLock { () -> CheckedContinuation<Value, Never>? in
            defer { continuation = nil }
            return continuation
        }
        retained?.resume(returning: value)
    }
}
