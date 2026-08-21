import Foundation

public enum HostReadinessName: String, CaseIterable, Codable, Equatable, Sendable {
    case serverCompatibility = "server_compatibility"
    case deviceEnrollment = "device_enrollment"
    case spotify
    case automation
    case audioCapture = "audio_capture"
    case relay
    case activeGame = "active_game"
}

public enum HostReadinessState: String, Codable, Equatable, Sendable {
    case checking, ready, blocked
}

public enum HostReadinessRecovery: String, Codable, Equatable, Sendable {
    case wait
    case retryServer = "retry_server"
    case updateHost = "update_host"
    case enrollDevice = "enroll_device"
    case installSpotify = "install_spotify"
    case openSpotify = "open_spotify"
    case signInSpotify = "sign_in_spotify"
    case retrySpotify = "retry_spotify"
    case allowAutomation = "allow_automation"
    case allowAudioCapture = "allow_audio_capture"
    case retryAudioCapture = "retry_audio_capture"
    case updateMacOS = "update_macos"
    case retryRelay = "retry_relay"
    case createGame = "create_game"

    public var message: String {
        switch self {
        case .wait: "Wait for this check to finish."
        case .retryServer: "Check the internet connection, then try the server again."
        case .updateHost: "Install the current CannaBeats Host release."
        case .enrollDevice: "Enroll this Mac with a current Host enrollment code."
        case .installSpotify: "Install the Spotify desktop application."
        case .openSpotify: "Open Spotify and keep it running."
        case .signInSpotify: "Sign in to a Spotify Premium account in the Spotify app."
        case .retrySpotify: "Check Spotify, then retry its readiness check."
        case .allowAutomation:
            "Allow CannaBeats to control Spotify in System Settings → Privacy & Security → Automation."
        case .allowAudioCapture:
            "Start shared audio, then allow System Audio Recording when macOS asks."
        case .retryAudioCapture:
            "Allow CannaBeats in System Settings → Privacy & Security → Screen & System Audio Recording, then retry."
        case .updateMacOS: "Update this Mac to macOS 14.2 or later."
        case .retryRelay: "Check the CannaBeats server and retry shared audio."
        case .createGame: "Create a game to continue."
        }
    }
}

public enum HostReadinessEvidence: Equatable, Sendable {
    case checking
    case ready
    case blocked(HostReadinessRecovery)
}

public struct HostReadinessCheck: Identifiable, Equatable, Sendable {
    public var id: HostReadinessName { name }
    public let name: HostReadinessName
    public let state: HostReadinessState
    public let recovery: HostReadinessRecovery?

    init(_ name: HostReadinessName, _ evidence: HostReadinessEvidence) {
        self.name = name
        switch evidence {
        case .checking:
            state = .checking
            recovery = .wait
        case .ready:
            state = .ready
            recovery = nil
        case .blocked(let reason):
            state = .blocked
            recovery = reason
        }
    }
}

public struct HostPrimaryAction: Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case createGame, resumeGame }
    public let kind: Kind
    public let enabled: Bool
    public let blockedBy: HostReadinessRecovery?
}

public struct HostReadinessProjection: Equatable, Sendable {
    public let checks: [HostReadinessCheck]
    public let activeGame: HostActiveGame?
    public let primaryAction: HostPrimaryAction

    /// The production audio/playback owner may exist only while the same
    /// readiness boundary permits resuming the retained game.
    public var sharedAudioRuntimeEnabled: Bool {
        activeGame != nil && primaryAction.kind == .resumeGame && primaryAction.enabled
    }

    public init(
        serverCompatibility: HostReadinessEvidence,
        deviceEnrollment: HostReadinessEvidence,
        spotify: HostReadinessEvidence,
        automation: HostReadinessEvidence,
        audioCapture: HostReadinessEvidence,
        relay: HostReadinessEvidence,
        activeGame: HostReadinessEvidence,
        game: HostActiveGame?
    ) {
        let values = [
            HostReadinessCheck(.serverCompatibility, serverCompatibility),
            HostReadinessCheck(.deviceEnrollment, deviceEnrollment),
            HostReadinessCheck(.spotify, spotify),
            HostReadinessCheck(.automation, automation),
            HostReadinessCheck(.audioCapture, audioCapture),
            HostReadinessCheck(.relay, relay),
            HostReadinessCheck(.activeGame, activeGame),
        ]
        precondition(values.map(\.name) == HostReadinessName.allCases)
        checks = values
        self.activeGame = game

        // Entering or creating the lobby requires server, device, Spotify,
        // Automation, and relay readiness. Audio capture is resolved by the
        // first game-scoped shared-audio start and independently gates playback.
        let prerequisites = [values[0], values[1], values[2], values[3], values[5]]
        let activeCheck = values[values.count - 1]
        let firstBlock = prerequisites.first(where: { $0.state != .ready })?.recovery
        if game != nil {
            primaryAction = HostPrimaryAction(
                kind: .resumeGame,
                enabled: firstBlock == nil && activeCheck.state == .ready,
                blockedBy: firstBlock ?? activeCheck.recovery
            )
        } else {
            let mayCreate = activeCheck.recovery == .createGame
            primaryAction = HostPrimaryAction(
                kind: .createGame,
                enabled: firstBlock == nil && mayCreate,
                blockedBy: firstBlock ?? (mayCreate ? nil : activeCheck.recovery)
            )
        }
    }

    public static var checking: HostReadinessProjection {
        HostReadinessProjection(
            serverCompatibility: .checking, deviceEnrollment: .checking,
            spotify: .checking, automation: .checking, audioCapture: .checking,
            relay: .checking, activeGame: .checking, game: nil
        )
    }
}

public enum HostReadinessBuilder {
    public static func build(
        server: Result<HostServerReadiness, HostAuthorityClientError>,
        enrolled: Bool,
        spotifyState: SpotifyApplicationState,
        spotifyReadback: SpotifyControllerResult<SpotifyReadback>?,
        audioCapture: AudioCaptureReadiness
    ) -> HostReadinessProjection {
        let serverEvidence: HostReadinessEvidence
        let relayEvidence: HostReadinessEvidence
        let gameEvidence: HostReadinessEvidence
        let game: HostActiveGame?
        switch server {
        case .success(let value):
            serverEvidence = .ready
            relayEvidence = value.relay.state == "ready" ? .ready : .blocked(.retryRelay)
            game = value.activeGame
            gameEvidence = game == nil ? .blocked(.createGame) : .ready
        case .failure(.server("upgrade_required")):
            serverEvidence = .blocked(.updateHost)
            relayEvidence = .checking
            gameEvidence = .checking
            game = nil
        case .failure:
            serverEvidence = .blocked(.retryServer)
            relayEvidence = .checking
            gameEvidence = .checking
            game = nil
        }

        var spotifyEvidence: HostReadinessEvidence
        var automationEvidence: HostReadinessEvidence
        switch spotifyState {
        case .missing:
            spotifyEvidence = .blocked(.installSpotify)
            automationEvidence = .blocked(.installSpotify)
        case .notRunning:
            spotifyEvidence = .blocked(.openSpotify)
            automationEvidence = .blocked(.openSpotify)
        case .running:
            spotifyEvidence = .ready
            switch spotifyReadback {
            case .success:
                automationEvidence = .ready
            case .failure(.automationDenied):
                automationEvidence = .blocked(.allowAutomation)
            case .failure(.spotifySignedOut):
                spotifyEvidence = .blocked(.signInSpotify)
                automationEvidence = .ready
            case .failure(.spotifyMissing):
                spotifyEvidence = .blocked(.installSpotify)
                automationEvidence = .blocked(.installSpotify)
            case .failure(.spotifyNotRunning):
                spotifyEvidence = .blocked(.openSpotify)
                automationEvidence = .blocked(.openSpotify)
            case .failure:
                automationEvidence = .blocked(.retrySpotify)
            case .none:
                automationEvidence = .checking
            }
        }

        let captureEvidence: HostReadinessEvidence = switch audioCapture {
        case .ready: .ready
        case .notDetermined: .blocked(.allowAudioCapture)
        case .failed: .blocked(.retryAudioCapture)
        case .unsupported: .blocked(.updateMacOS)
        }
        return HostReadinessProjection(
            serverCompatibility: serverEvidence,
            deviceEnrollment: enrolled ? .ready : .blocked(.enrollDevice),
            spotify: spotifyEvidence,
            automation: automationEvidence,
            audioCapture: captureEvidence,
            relay: relayEvidence,
            activeGame: gameEvidence,
            game: game
        )
    }
}
