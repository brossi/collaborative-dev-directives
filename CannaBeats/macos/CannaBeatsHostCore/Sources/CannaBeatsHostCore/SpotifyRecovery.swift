import Foundation

public enum SpotifyRecoveryRoute: String, Equatable, Sendable {
    case installSpotify
    case openSpotify
    case signInToSpotify
    case automationSettings
    case retryReadback
    case restartSpotify
    case restartHost
}

public struct SpotifyRecoveryGuidance: Equatable, Sendable {
    public let message: String
    public let route: SpotifyRecoveryRoute

    public init(message: String, route: SpotifyRecoveryRoute) {
        self.message = message
        self.route = route
    }
}

public enum SpotifyRecoveryGuide {
    public static func guidance(for failure: SpotifyControllerFailure) -> SpotifyRecoveryGuidance {
        switch failure {
        case .spotifyMissing:
            SpotifyRecoveryGuidance(
                message: "Install the Spotify desktop app, then run Spotify setup again.",
                route: .installSpotify
            )
        case .spotifyNotRunning:
            SpotifyRecoveryGuidance(
                message: "Open Spotify and keep it running while hosting the game.",
                route: .openSpotify
            )
        case .spotifySignedOut:
            SpotifyRecoveryGuidance(
                message: "Sign in to a Spotify Premium account in the Spotify desktop app.",
                route: .signInToSpotify
            )
        case .automationDenied:
            SpotifyRecoveryGuidance(
                message: "In System Settings, open Privacy & Security → Automation and allow CannaBeats to control Spotify.",
                route: .automationSettings
            )
        case .commandTimeout:
            SpotifyRecoveryGuidance(
                message: "Check Spotify, then retry readback before sending another playback command.",
                route: .retryReadback
            )
        case .unexpectedTrack:
            SpotifyRecoveryGuidance(
                message: "Return to Spotify, stop any manual track change, and retry this round.",
                route: .openSpotify
            )
        case .responseLost:
            SpotifyRecoveryGuidance(
                message: "Reconnect to the CannaBeats server; the retained command will be reconciled before playback resumes.",
                route: .restartHost
            )
        case .unrecognized:
            SpotifyRecoveryGuidance(
                message: "Restart Spotify and run Spotify setup again.",
                route: .restartSpotify
            )
        }
    }
}
