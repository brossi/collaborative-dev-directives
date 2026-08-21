import CryptoKit
import Foundation

public enum PlaybackCommandKind: String, Codable, Equatable, Sendable {
    case playTrack = "play_track"
    case play
    case pause
}

public struct SpotifyPlaybackIntent: Equatable, Sendable {
    public let kind: PlaybackCommandKind
    public let trackUri: String?

    public init(kind: PlaybackCommandKind, trackUri: String? = nil) {
        self.kind = kind
        self.trackUri = trackUri
    }
}

public enum SpotifyPlaybackOutcome: Equatable, Sendable {
    case accepted(readback: SpotifyReadback, outcomeHash: String)
    case failed(SpotifyControllerFailure)
    case outcomeUnknown(SpotifyControllerFailure)
}

@MainActor
public struct SpotifyPlaybackCoordinator {
    private let controller: any SpotifyControlling

    public init(controller: any SpotifyControlling) {
        self.controller = controller
    }

    public func perform(
        _ intent: SpotifyPlaybackIntent,
        allowExecution: Bool = true
    ) async -> SpotifyPlaybackOutcome {
        guard valid(intent) else { return .failed(.unrecognized) }
        switch controller.applicationState() {
        case .missing:
            return allowExecution ? .failed(.spotifyMissing) : .outcomeUnknown(.unrecognized)
        case .notRunning:
            return allowExecution ? .failed(.spotifyNotRunning) : .outcomeUnknown(.unrecognized)
        case .running: break
        }
        let prior: SpotifyReadback
        switch await controller.readback() {
        case .success(let readback): prior = readback
        case .failure(let failure):
            return allowExecution ? outcome(for: failure) : .outcomeUnknown(.unrecognized)
        }
        if desired(intent, holdsIn: prior) { return accepted(prior) }
        guard allowExecution else { return .outcomeUnknown(.unrecognized) }

        let execution: SpotifyControllerResult<Void>
        switch intent.kind {
        case .playTrack: execution = await controller.playTrack(uri: intent.trackUri!)
        case .play: execution = await controller.play()
        case .pause: execution = await controller.pause()
        }
        if case .failure(let failure) = execution { return outcome(for: failure) }

        switch await controller.readback() {
        case .failure(let failure): return outcome(for: failure)
        case .success(let readback):
            guard desired(intent, holdsIn: readback) else {
                return .failed(intent.kind == .playTrack ? .unexpectedTrack : .unrecognized)
            }
            return accepted(readback)
        }
    }

    private func valid(_ intent: SpotifyPlaybackIntent) -> Bool {
        switch intent.kind {
        case .playTrack:
            guard let uri = intent.trackUri else { return false }
            return uri.range(
                of: #"^spotify:track:[0-9A-Za-z]{22}$"#,
                options: .regularExpression
            ) != nil
        case .play, .pause: return intent.trackUri == nil
        }
    }

    private func desired(_ intent: SpotifyPlaybackIntent, holdsIn readback: SpotifyReadback) -> Bool {
        switch intent.kind {
        case .playTrack:
            readback.playerState == .playing && readback.trackUri == intent.trackUri
        case .play: readback.playerState == .playing
        case .pause: readback.playerState == .paused
        }
    }

    private func accepted(_ readback: SpotifyReadback) -> SpotifyPlaybackOutcome {
        guard let data = try? JSONEncoder.canonical.encode(readback) else {
            return .failed(.unrecognized)
        }
        return .accepted(
            readback: readback,
            outcomeHash: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        )
    }

    private func outcome(for failure: SpotifyControllerFailure) -> SpotifyPlaybackOutcome {
        switch failure {
        case .commandTimeout, .responseLost: .outcomeUnknown(failure)
        default: .failed(failure)
        }
    }
}

extension JSONEncoder {
    fileprivate static var canonical: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}
