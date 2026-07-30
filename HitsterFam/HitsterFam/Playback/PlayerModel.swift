import Foundation

/// What any audio backend must provide. `SpotifyBackend` is the real one;
/// `StubBackend` lets the whole game loop run before the SpotifyiOS
/// framework is added to the project. Backends call delegate methods on
/// the main thread.
protocol PlayerBackend: AnyObject {
    var delegate: PlayerBackendDelegate? { get set }
    var isConnected: Bool { get }
    func connect(warmupURI: String)
    func handleAuthCallback(url: URL)
    func appDidBecomeActive()
    func play(uri: String)
    func pause()
    func resume()
}

protocol PlayerBackendDelegate: AnyObject {
    func backendDidConnect()
    func backendDidDisconnect(error: String?)
    func backendPlaybackChanged(isPaused: Bool)
}

@MainActor
final class PlayerModel: ObservableObject {
    enum Status: Equatable { case disconnected, connecting, connected }

    @Published private(set) var status: Status = .disconnected
    @Published private(set) var isPaused = false
    @Published var lastError: String?

    let usingStub: Bool
    private let backend: PlayerBackend
    private var pendingAction: (() -> Void)?

    init() {
        #if canImport(SpotifyiOS)
        backend = SpotifyBackend()
        usingStub = false
        #else
        backend = StubBackend()
        usingStub = true
        #endif
        backend.delegate = self
    }

    func connect() {
        guard !backend.isConnected else {
            status = .connected
            return
        }
        status = .connecting
        backend.connect(warmupURI: SpotifyConfig.warmupTrackURI)
    }

    func handleAuthCallback(url: URL) {
        backend.handleAuthCallback(url: url)
    }

    func appDidBecomeActive() {
        backend.appDidBecomeActive()
    }

    func play(uri: String) {
        perform { [self] in
            backend.play(uri: uri)
            isPaused = false
        }
    }

    func togglePlayPause() {
        perform { [self] in
            if isPaused { backend.resume() } else { backend.pause() }
            isPaused.toggle()
        }
    }

    /// Reconnect-before-action guard: App Remote drops its connection when
    /// the Spotify app is suspended during a long table debate. Every user
    /// action funnels through here — if the connection is gone, silently
    /// reconnect and run the action once it's back. The host never sees a
    /// raw "not connected" error mid-game.
    private func perform(_ action: @escaping () -> Void) {
        if status == .connected, backend.isConnected {
            action()
        } else {
            pendingAction = action
            status = .connecting
            backend.connect(warmupURI: SpotifyConfig.warmupTrackURI)
        }
    }
}

extension PlayerModel: PlayerBackendDelegate {
    nonisolated func backendDidConnect() {
        Task { @MainActor in
            status = .connected
            lastError = nil
            pendingAction?()
            pendingAction = nil
        }
    }

    nonisolated func backendDidDisconnect(error: String?) {
        Task { @MainActor in
            status = .disconnected
            if let error { lastError = error }
        }
    }

    nonisolated func backendPlaybackChanged(isPaused: Bool) {
        Task { @MainActor in
            self.isPaused = isPaused
        }
    }
}
