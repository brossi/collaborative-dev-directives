import Foundation

@MainActor
public final class PlaybackAudioGate {
    private let startPlayback: @MainActor @Sendable () -> Void
    private let stopPlayback: @MainActor @Sendable () -> Void
    private var isReady = false
    private var isClosed = false

    public init(
        start: @escaping @MainActor @Sendable () -> Void,
        stop: @escaping @MainActor @Sendable () -> Void
    ) {
        startPlayback = start
        stopPlayback = stop
    }

    public func setSharedAudioReady(_ ready: Bool) {
        guard !isClosed, ready != isReady else { return }
        isReady = ready
        if ready { startPlayback() } else { stopPlayback() }
    }

    public func close() {
        guard !isClosed else { return }
        isClosed = true
        if isReady {
            isReady = false
            stopPlayback()
        }
    }
}

@MainActor
public final class HostGameRuntimeOwner {
    public typealias PlaybackFactory = @MainActor (UUID) -> PlaybackPollingOwner
    public typealias AudioFactory = @MainActor (
        @escaping @MainActor @Sendable (Bool) -> Void
    ) -> SharedAudioOwner

    public private(set) var gameID: UUID?
    public private(set) var playback: PlaybackPollingOwner?
    public private(set) var sharedAudio: SharedAudioOwner?

    private let playbackFactory: PlaybackFactory
    private let audioFactory: AudioFactory
    private let reportPlayback: @MainActor @Sendable (PlaybackOwnerEvent) -> Void
    private var gate: PlaybackAudioGate?
    private var operationGeneration: UInt64 = 0

    public init(
        origin: URL = HostAuthorityProtocol.productionOrigin,
        playbackFactory: PlaybackFactory? = nil,
        audioFactory: AudioFactory? = nil,
        reportPlayback: @escaping @MainActor @Sendable (PlaybackOwnerEvent) -> Void
            = { _ in }
    ) {
        self.playbackFactory = playbackFactory ?? { PlaybackPollingOwner(gameID: $0, origin: origin) }
        self.audioFactory = audioFactory ?? { callback in
            SharedAudioOwner(origin: origin, playbackGate: callback)
        }
        self.reportPlayback = reportPlayback
    }

    public func start(gameID: UUID) async {
        if self.gameID == gameID { return }
        operationGeneration &+= 1
        let operation = operationGeneration
        let oldAudio = sharedAudio
        let oldGate = gate
        self.gameID = gameID
        sharedAudio = nil
        gate = nil
        playback = nil
        oldGate?.close()
        await oldAudio?.stop()
        guard operation == operationGeneration, self.gameID == gameID else { return }
        let playback = playbackFactory(gameID)
        let gate = PlaybackAudioGate(
            start: { [playback, reportPlayback] in playback.start(report: reportPlayback) },
            stop: { [playback] in playback.stop() }
        )
        let audio = audioFactory { [weak gate] ready in
            gate?.setSharedAudioReady(ready)
        }
        self.gameID = gameID
        self.playback = playback
        self.gate = gate
        sharedAudio = audio
        await audio.start(gameID: gameID)
        if operation != operationGeneration || self.gameID != gameID {
            await audio.stop()
            gate.close()
        }
    }

    public func reconnectSharedAudio() {
        sharedAudio?.reconnect()
    }

    public func stop() async {
        operationGeneration &+= 1
        let oldAudio = sharedAudio
        let oldGate = gate
        sharedAudio = nil
        gate = nil
        playback = nil
        gameID = nil
        oldGate?.close()
        await oldAudio?.stop()
    }
}
