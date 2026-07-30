import Foundation

/// Fake backend so the full game loop runs on-device or in the simulator
/// before the SpotifyiOS framework is dropped in. Logs instead of playing.
/// `PlayerModel` selects it automatically whenever SpotifyiOS is absent.
final class StubBackend: PlayerBackend {
    weak var delegate: PlayerBackendDelegate?
    private(set) var isConnected = false

    func connect(warmupURI: String) {
        print("[StubBackend] connect — would play warm-up \(warmupURI)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self else { return }
            self.isConnected = true
            self.delegate?.backendDidConnect()
        }
    }

    func handleAuthCallback(url: URL) {
        print("[StubBackend] auth callback: \(url)")
    }

    func appDidBecomeActive() {}

    func play(uri: String) {
        print("[StubBackend] play \(uri)")
    }

    func pause() {
        print("[StubBackend] pause")
    }

    func resume() {
        print("[StubBackend] resume")
    }
}
