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
    func backendCommandFailed(_ message: String)
}

@MainActor
final class PlayerModel: ObservableObject {
    enum Status: Equatable { case disconnected, connecting, connected }

    @Published private(set) var status: Status = .disconnected
    @Published private(set) var isPaused = false
    @Published var lastError: String?

    let usingStub: Bool
    private let backend: PlayerBackend
    private var pendingAction: (queued: Date, run: () -> Void)?
    private var connectTimeoutTask: Task<Void, Never>?
    /// Set on the auth-bounce return leg; the handshake leaves the warm-up
    /// track playing, so the next successful connect pauses it (unless a
    /// pending action is about to play a deck song anyway).
    private var didAuthBounce = false

    private static let placeholderClientID = "YOUR_SPOTIFY_CLIENT_ID"
    /// Discard a queued action older than this — a play request from a
    /// failed reconnect minutes ago must not fire out of nowhere.
    private static let pendingActionMaxAge: TimeInterval = 15
    private static let connectTimeoutSeconds: TimeInterval = 15

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
        // The stub ignores the client ID; the real backend can never
        // connect with the placeholder — refuse loudly instead of hanging.
        guard usingStub || SpotifyConfig.clientID != Self.placeholderClientID else {
            lastError = "Missing Spotify client ID — add Resources/SpotifyClientID.txt"
            status = .disconnected
            return
        }
        beginConnecting()
    }

    func handleAuthCallback(url: URL) {
        didAuthBounce = true
        backend.handleAuthCallback(url: url)
    }

    func appDidBecomeActive() {
        backend.appDidBecomeActive()
    }

    func play(uri: String) {
        perform { [self] in
            backend.play(uri: uri)
        }
    }

    func togglePlayPause() {
        // isPaused is written by the player-state subscription
        // (backendPlaybackChanged), not optimistically here.
        perform { [self] in
            if isPaused { backend.resume() } else { backend.pause() }
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
            pendingAction = (Date(), action)
            beginConnecting()
        }
    }

    private func beginConnecting() {
        status = .connecting
        scheduleConnectTimeout()
        backend.connect(warmupURI: SpotifyConfig.warmupTrackURI)
    }

    /// If nothing answers within the window, stop showing an eternal
    /// spinner. Cancelled by any connect/disconnect callback.
    private func scheduleConnectTimeout() {
        connectTimeoutTask?.cancel()
        connectTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.connectTimeoutSeconds * 1_000_000_000))
            guard let self, !Task.isCancelled, self.status == .connecting else { return }
            self.status = .disconnected
            self.lastError = "Spotify didn't respond — is the Spotify app installed and logged in?"
        }
    }
}

extension PlayerModel: PlayerBackendDelegate {
    nonisolated func backendDidConnect() {
        Task { @MainActor in
            connectTimeoutTask?.cancel()
            status = .connected
            lastError = nil
            let pending = pendingAction
            pendingAction = nil
            if let pending, Date().timeIntervalSince(pending.queued) < Self.pendingActionMaxAge {
                pending.run()
            } else if didAuthBounce {
                // Handshake finished with nothing to play — stop the
                // warm-up track it left running.
                backend.pause()
            }
            didAuthBounce = false
        }
    }

    nonisolated func backendDidDisconnect(error: String?) {
        Task { @MainActor in
            connectTimeoutTask?.cancel()
            status = .disconnected
            if let error { lastError = error }
        }
    }

    nonisolated func backendPlaybackChanged(isPaused: Bool) {
        Task { @MainActor in
            self.isPaused = isPaused
        }
    }

    nonisolated func backendCommandFailed(_ message: String) {
        Task { @MainActor in
            lastError = message
        }
    }
}
