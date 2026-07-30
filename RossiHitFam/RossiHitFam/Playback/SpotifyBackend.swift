// Real backend: remote-controls the installed Spotify app over App Remote.
// This entire file only compiles once SpotifyiOS.xcframework is added to
// the project (see README) — until then `PlayerModel` uses `StubBackend`.
#if canImport(SpotifyiOS)
import Foundation
import SpotifyiOS

final class SpotifyBackend: NSObject, PlayerBackend {
    weak var delegate: PlayerBackendDelegate?

    private var accessToken: String? {
        didSet { appRemote.connectionParameters.accessToken = accessToken }
    }

    private lazy var appRemote: SPTAppRemote = {
        let configuration = SPTConfiguration(
            clientID: SpotifyConfig.clientID,
            redirectURL: SpotifyConfig.redirectURL
        )
        let remote = SPTAppRemote(configuration: configuration, logLevel: .none)
        remote.delegate = self
        return remote
    }()

    var isConnected: Bool { appRemote.isConnected }

    func connect(warmupURI: String) {
        if accessToken != nil {
            // Already authorized this launch — plain reconnect, no bounce.
            appRemote.connect()
        } else {
            // One-time handshake: bounces to the Spotify app, which briefly
            // shows (and plays) the warm-up track, then returns via the
            // redirect URI handled in handleAuthCallback below.
            appRemote.authorizeAndPlayURI(warmupURI)
        }
    }

    func handleAuthCallback(url: URL) {
        let parameters = appRemote.authorizationParameters(from: url)
        if let token = parameters?[SPTAppRemoteAccessTokenKey] {
            accessToken = token
            appRemote.connect()
        } else if let message = parameters?[SPTAppRemoteErrorDescriptionKey] {
            delegate?.backendDidDisconnect(error: message)
        }
    }

    func appDidBecomeActive() {
        if accessToken != nil, !appRemote.isConnected {
            appRemote.connect()
        }
    }

    func play(uri: String) {
        appRemote.playerAPI?.play(uri, callback: logErrors)
    }

    func pause() {
        appRemote.playerAPI?.pause(logErrors)
    }

    func resume() {
        appRemote.playerAPI?.resume(logErrors)
    }

    private let logErrors: SPTAppRemoteCallback = { _, error in
        if let error {
            print("[SpotifyBackend] \(error.localizedDescription)")
        }
    }
}

extension SpotifyBackend: SPTAppRemoteDelegate {
    func appRemoteDidEstablishConnection(_ appRemote: SPTAppRemote) {
        appRemote.playerAPI?.delegate = self
        appRemote.playerAPI?.subscribe(toPlayerState: logErrors)
        delegate?.backendDidConnect()
    }

    func appRemote(_ appRemote: SPTAppRemote, didFailConnectionAttemptWithError error: Error?) {
        delegate?.backendDidDisconnect(error: error?.localizedDescription)
    }

    func appRemote(_ appRemote: SPTAppRemote, didDisconnectWithError error: Error?) {
        delegate?.backendDidDisconnect(error: error?.localizedDescription)
    }
}

extension SpotifyBackend: SPTAppRemotePlayerStateDelegate {
    func playerStateDidChange(_ playerState: SPTAppRemotePlayerState) {
        delegate?.backendPlaybackChanged(isPaused: playerState.isPaused)
    }
}
#endif
