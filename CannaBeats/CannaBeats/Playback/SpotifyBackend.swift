// Real backend: remote-controls the installed Spotify app over App Remote.
// This entire file only compiles once SpotifyiOS.xcframework is added to
// the project (see README) — until then `PlayerModel` uses `StubBackend`.
#if canImport(SpotifyiOS)
import Foundation
import UIKit
import SpotifyiOS

final class SpotifyBackend: NSObject, PlayerBackend {
    weak var delegate: PlayerBackendDelegate?

    /// Last track reported by the player-state subscription. Held only to
    /// hand to the image API on reveal — SPTAppRemoteTrack conforms to
    /// SPTAppRemoteImageRepresentable, so no separate artwork lookup exists.
    private var currentTrack: SPTAppRemoteTrack?

    private var accessToken: String? {
        didSet { appRemote.connectionParameters.accessToken = accessToken }
    }

    /// True while a plain `connect()` (no auth bounce) is in flight. A plain
    /// connect cannot wake a killed Spotify app, so if it fails we drop the
    /// token and the next `connect()` falls back to `authorizeAndPlayURI`
    /// (the only wake path). The first-ever connect has no token and goes
    /// straight to `authorizeAndPlayURI` as before.
    private var hasTriedPlainConnect = false

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
            hasTriedPlainConnect = true
            appRemote.connect()
        } else {
            // Handshake: bounces to the Spotify app, which briefly
            // shows (and plays) the warm-up track, then returns via the
            // redirect URI handled in handleAuthCallback below.
            appRemote.authorizeAndPlayURI(warmupURI)
        }
    }

    func handleAuthCallback(url: URL) {
        let parameters = appRemote.authorizationParameters(from: url)
        if let token = parameters?[SPTAppRemoteAccessTokenKey] {
            print("[SpotifyBackend] auth OK, token received; connecting")
            accessToken = token
            hasTriedPlainConnect = true
            appRemote.connect()
        } else if let message = parameters?[SPTAppRemoteErrorDescriptionKey] {
            print("[SpotifyBackend] auth refused: \(message)")
            delegate?.backendDidDisconnect(error: "Spotify auth refused: \(message)")
        } else {
            // Neither key present: previously fell through silently, leaving
            // the UI stuck mid-connect with no explanation.
            print("[SpotifyBackend] callback had no token and no error: \(url)")
            delegate?.backendDidDisconnect(
                error: "Spotify returned no token (check the app's iOS bundle ID in the dashboard)")
        }
    }

    func appDidBecomeActive() {
        if accessToken != nil, !appRemote.isConnected {
            hasTriedPlainConnect = true
            appRemote.connect()
        }
    }

    func play(uri: String) {
        guard let playerAPI = appRemote.playerAPI else {
            delegate?.backendCommandFailed("Spotify not ready — play failed")
            return
        }
        playerAPI.play(uri, callback: commandCallback("Play"))
    }

    func pause() {
        guard let playerAPI = appRemote.playerAPI else {
            delegate?.backendCommandFailed("Spotify not ready — pause failed")
            return
        }
        playerAPI.pause(commandCallback("Pause"))
    }

    func resume() {
        guard let playerAPI = appRemote.playerAPI else {
            delegate?.backendCommandFailed("Spotify not ready — resume failed")
            return
        }
        playerAPI.resume(commandCallback("Resume"))
    }

    /// Cover art for the playing track, straight from the Spotify app — no
    /// artwork URL is stored in the catalog and no network call is made here.
    /// nil whenever the app isn't connected or the fetch fails; the reveal
    /// card simply renders without a picture.
    func fetchCurrentArtwork(size: CGSize, completion: @escaping (UIImage?) -> Void) {
        guard let imageAPI = appRemote.imageAPI, let track = currentTrack else {
            completion(nil)
            return
        }
        imageAPI.fetchImage(forItem: track, with: size) { result, error in
            if let error {
                print("[SpotifyBackend] artwork: \(error.localizedDescription)")
            }
            completion(result as? UIImage)
        }
    }

    /// Command result handler: logs and surfaces failures to the delegate.
    private func commandCallback(_ command: String) -> SPTAppRemoteCallback {
        { [weak self] _, error in
            guard let error else { return }
            print("[SpotifyBackend] \(command): \(error.localizedDescription)")
            self?.delegate?.backendCommandFailed("\(command) failed: \(error.localizedDescription)")
        }
    }

    private let logErrors: SPTAppRemoteCallback = { _, error in
        if let error {
            print("[SpotifyBackend] \(error.localizedDescription)")
        }
    }
}

extension SpotifyBackend: SPTAppRemoteDelegate {
    func appRemoteDidEstablishConnection(_ appRemote: SPTAppRemote) {
        hasTriedPlainConnect = false
        appRemote.playerAPI?.delegate = self
        appRemote.playerAPI?.subscribe(toPlayerState: logErrors)
        delegate?.backendDidConnect()
    }

    func appRemote(_ appRemote: SPTAppRemote, didFailConnectionAttemptWithError error: Error?) {
        if hasTriedPlainConnect {
            hasTriedPlainConnect = false
            accessToken = nil
        }
        // Name the phase: an auth failure and a post-auth connect failure
        // need completely different fixes, and both used to read alike.
        let detail = Self.describe(error)
        print("[SpotifyBackend] connect attempt failed: \(detail)")
        delegate?.backendDidDisconnect(error: "App Remote connect failed: \(detail)")
    }

    /// Domain + code alongside the message — App Remote's localized strings
    /// are often just "an unknown error occurred", which identifies nothing.
    private static func describe(_ error: Error?) -> String {
        guard let error else { return "no error object" }
        let ns = error as NSError
        return "\(ns.localizedDescription) [\(ns.domain) \(ns.code)]"
    }

    func appRemote(_ appRemote: SPTAppRemote, didDisconnectWithError error: Error?) {
        if hasTriedPlainConnect {
            hasTriedPlainConnect = false
            accessToken = nil
        }
        let detail = Self.describe(error)
        print("[SpotifyBackend] disconnected: \(detail)")
        delegate?.backendDidDisconnect(error: error == nil ? nil : "Disconnected: \(detail)")
    }
}

extension SpotifyBackend: SPTAppRemotePlayerStateDelegate {
    func playerStateDidChange(_ playerState: SPTAppRemotePlayerState) {
        currentTrack = playerState.track
        delegate?.backendPlaybackChanged(isPaused: playerState.isPaused)
    }
}
#endif
