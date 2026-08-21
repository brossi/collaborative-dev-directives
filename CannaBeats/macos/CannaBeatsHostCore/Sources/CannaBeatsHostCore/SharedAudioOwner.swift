import AudioTapBridge
import Foundation

public protocol AudioSessionControlling: Sendable {
    func current(gameID: UUID) async throws -> AudioSessionProjection?
    func open(
        gameID: UUID, audioSessionID: UUID, requestID: UUID
    ) async throws -> AudioSessionProjection
    func end(
        gameID: UUID, audioSessionID: UUID, requestID: UUID
    ) async throws -> AudioSessionProjection
}

extension AudioSessionClient: AudioSessionControlling {}

public protocol SharedAudioCapturing: AnyObject, Sendable {
    var sampleRate: Int { get }
    var capturedFrames: UInt64 { get }
    var droppedPackets: UInt64 { get }
    var droppedFrames: UInt64 { get }
    func start(packetHandler: @escaping @Sendable (Data) -> Void) throws
    func stop()
}

public protocol SharedAudioIngesting: AnyObject, Sendable {
    var droppedPackets: UInt64 { get }
    var droppedFrames: UInt64 { get }
    var queuedPackets: Int { get }
    func start(report: @escaping @Sendable (AudioIngestEvent) -> Void)
    @discardableResult func enqueue(_ packet: Data) -> Bool
    func stop()
}

extension AuthenticatedAudioIngest: SharedAudioIngesting {}

public protocol SharedAudioListening: AnyObject, Sendable {
    func start(
        report: @escaping @Sendable (AudioListenerEvent) -> Void,
        consume: @escaping @Sendable (Data) -> Void
    )
    func stop()
}

extension AuthenticatedAudioListener: SharedAudioListening {}

public protocol SharedAudioPlaying: AnyObject, Sendable {
    var queuedPackets: Int { get }
    var droppedPackets: UInt64 { get }
    var droppedFrames: UInt64 { get }
    func start(sampleRate: Int) throws
    @discardableResult func append(interleavedInt16 data: Data) -> Bool
    func stop()
}

extension RelayedAudioPlayer: SharedAudioPlaying {}

public final class SpotifyProcessCapture: SharedAudioCapturing, @unchecked Sendable {
    private let tap = CBAudioTap()

    public init() {}

    public var sampleRate: Int { Int(tap.sampleRate.rounded()) }
    public var capturedFrames: UInt64 { tap.capturedFrames }
    public var droppedPackets: UInt64 { tap.droppedPackets }
    public var droppedFrames: UInt64 { tap.droppedFrames }

    public func start(packetHandler: @escaping @Sendable (Data) -> Void) throws {
        do { try tap.startSpotify(packetHandler: packetHandler) }
        catch { throw SharedAudioFailure.unavailable }
        guard [44_100, 48_000].contains(sampleRate), tap.channelCount == 2 else {
            tap.stop()
            throw SharedAudioFailure.invalidFormat
        }
    }

    public func stop() { tap.stop() }
    deinit { tap.stop() }
}

private final class AudioPacketForwarder: @unchecked Sendable {
    private let lock = NSLock()
    private weak var target: (any SharedAudioIngesting)?
    private var packetsBeforeIngest: UInt64 = 0
    private var framesBeforeIngest: UInt64 = 0

    func install(_ target: any SharedAudioIngesting) {
        lock.lock()
        self.target = target
        lock.unlock()
    }

    func clear() {
        lock.lock()
        target = nil
        lock.unlock()
    }

    func forward(_ packet: Data) {
        lock.lock()
        guard let target else {
            packetsBeforeIngest += 1
            framesBeforeIngest += UInt64(packet.count / 4)
            lock.unlock()
            return
        }
        lock.unlock()
        _ = target.enqueue(packet)
    }

    func droppedBeforeIngest() -> (packets: UInt64, frames: UInt64) {
        lock.lock()
        defer { lock.unlock() }
        return (packetsBeforeIngest, framesBeforeIngest)
    }
}

private final class StartupSignal<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?
    private var result: Result<Value, Error>?

    func wait(timeout: Duration) async throws -> Value {
        let value: Value = try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let result {
                lock.unlock()
                continuation.resume(with: result)
            } else {
                self.continuation = continuation
                lock.unlock()
            }
        }
        return value
    }

    func resolve(_ result: Result<Value, Error>) {
        lock.lock()
        guard self.result == nil else { lock.unlock(); return }
        self.result = result
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(with: result)
    }
}

private final class StartupFence: @unchecked Sendable {
    private let lock = NSLock()
    private var failure: SharedAudioFailure?

    func fail(_ value: SharedAudioFailure) {
        lock.lock()
        if failure == nil { failure = value }
        lock.unlock()
    }

    func requireHealthy() throws {
        lock.lock()
        let failure = failure
        lock.unlock()
        if let failure { throw failure }
    }
}

public struct SharedAudioCounters: Equatable, Sendable {
    public let capturedFrames: UInt64
    public let captureDroppedPackets: UInt64
    public let captureDroppedFrames: UInt64
    public let preIngestDroppedPackets: UInt64
    public let preIngestDroppedFrames: UInt64
    public let uploadDroppedPackets: UInt64
    public let uploadDroppedFrames: UInt64
    public let uploadQueuedPackets: Int
    public let playerDroppedPackets: UInt64
    public let playerDroppedFrames: UInt64
    public let playerQueuedPackets: Int
    public let discontinuities: UInt64
    public let reconnectAttempts: UInt64
    public let terminalFailures: UInt64
}

private struct RetainedSharedAudioCounters {
    var capturedFrames: UInt64 = 0
    var captureDroppedPackets: UInt64 = 0
    var captureDroppedFrames: UInt64 = 0
    var preIngestDroppedPackets: UInt64 = 0
    var preIngestDroppedFrames: UInt64 = 0
    var uploadDroppedPackets: UInt64 = 0
    var uploadDroppedFrames: UInt64 = 0
    var playerDroppedPackets: UInt64 = 0
    var playerDroppedFrames: UInt64 = 0
    var discontinuities: UInt64 = 0
    var reconnectAttempts: UInt64 = 0
    var terminalFailures: UInt64 = 0
}

public enum SharedAudioOwnerState: Equatable, Sendable {
    case idle
    case preparing
    case reconnecting(attempt: Int)
    case active(SharedAudioStreamIdentity)
    case interrupted(SharedAudioFailure)
    case stopPending(SharedAudioFailure)
    case stopped
}

@MainActor
public final class SharedAudioOwner {
    public typealias IngestFactory = @Sendable (
        SharedAudioStreamIdentity, String, Int
    ) throws -> any SharedAudioIngesting
    public typealias ListenerFactory = @Sendable (
        SharedAudioStreamIdentity, String
    ) throws -> any SharedAudioListening

    public private(set) var state: SharedAudioOwnerState = .idle

    private let origin: URL
    private let sessionClient: any AudioSessionControlling
    private let loadSession: @Sendable () throws -> String?
    private let captureFactory: @Sendable () -> any SharedAudioCapturing
    private let ingestFactory: IngestFactory
    private let listenerFactory: ListenerFactory
    private let playerFactory: @Sendable () -> any SharedAudioPlaying
    private let capturePermission: any AudioCaptureAuthorizing
    private let sleep: @Sendable (Duration) async -> Void
    private let playbackGate: @MainActor @Sendable (Bool) -> Void
    private let loadEndIntent: @Sendable () throws -> HostPendingAudioEnd?
    private let saveEndIntent: @Sendable (HostPendingAudioEnd) throws -> Void
    private let clearEndIntent: @Sendable () throws -> Void
    private var gameID: UUID?
    private var retainedSession: AudioSessionProjection?
    private var applicationSession: String?
    private var capture: (any SharedAudioCapturing)?
    private var ingest: (any SharedAudioIngesting)?
    private var listener: (any SharedAudioListening)?
    private var player: (any SharedAudioPlaying)?
    private var forwarder: AudioPacketForwarder?
    private var recoveryTask: Task<Void, Never>?
    private var operationGeneration: UInt64 = 0
    private var transportGeneration: UInt64 = 0
    private var retainedCounters = RetainedSharedAudioCounters()
    private var pendingEndIntent: HostPendingAudioEnd?
    private var endIntentPersisted = false
    private var transportFence: StartupFence?

    public init(
        origin: URL = HostAuthorityProtocol.productionOrigin,
        sessionClient: any AudioSessionControlling = AudioSessionClient(),
        loadSession: @escaping @Sendable () throws -> String? = {
            try HostCredentials.applicationSession()
        },
        captureFactory: @escaping @Sendable () -> any SharedAudioCapturing = {
            SpotifyProcessCapture()
        },
        ingestFactory: IngestFactory? = nil,
        listenerFactory: ListenerFactory? = nil,
        playerFactory: @escaping @Sendable () -> any SharedAudioPlaying = {
            RelayedAudioPlayer()
        },
        capturePermission: any AudioCaptureAuthorizing = SystemAudioCapturePermission(),
        sleep: @escaping @Sendable (Duration) async -> Void = {
            try? await Task.sleep(for: $0)
        },
        playbackGate: @escaping @MainActor @Sendable (Bool) -> Void = { _ in },
        loadEndIntent: @escaping @Sendable () throws -> HostPendingAudioEnd? = {
            try HostCredentials.pendingAudioEnd()
        },
        saveEndIntent: @escaping @Sendable (HostPendingAudioEnd) throws -> Void = {
            try HostCredentials.savePendingAudioEnd($0)
        },
        clearEndIntent: @escaping @Sendable () throws -> Void = {
            try HostCredentials.clearPendingAudioEnd()
        }
    ) {
        self.origin = origin
        self.sessionClient = sessionClient
        self.loadSession = loadSession
        self.captureFactory = captureFactory
        self.ingestFactory = ingestFactory ?? { identity, token, rate in
            try AuthenticatedAudioIngest(
                origin: origin, identity: identity,
                applicationSession: token, sampleRate: rate
            )
        }
        self.listenerFactory = listenerFactory ?? { identity, token in
            try AuthenticatedAudioListener(
                origin: origin, identity: identity, applicationSession: token
            )
        }
        self.playerFactory = playerFactory
        self.capturePermission = capturePermission
        self.sleep = sleep
        self.playbackGate = playbackGate
        self.loadEndIntent = loadEndIntent
        self.saveEndIntent = saveEndIntent
        self.clearEndIntent = clearEndIntent
    }

    public func start(gameID: UUID) async {
        guard [.idle, .stopped].contains(state) else { return }
        await beginPrepare(gameID: gameID, resetCounters: true)
    }

    private func beginPrepare(gameID: UUID, resetCounters: Bool) async {
        operationGeneration &+= 1
        let operation = operationGeneration
        recoveryTask?.cancel()
        recoveryTask = nil
        if resetCounters { retainedCounters = RetainedSharedAudioCounters() }
        state = .preparing
        self.gameID = gameID
        playbackGate(false)
        guard await reconcilePendingEnd() else {
            if operation == operationGeneration, state != .stopped {
                state = .stopPending(.unavailable)
            }
            return
        }
        guard operation == operationGeneration, state == .preparing else { return }
        await prepare(gameID: gameID, operation: operation)
    }

    private func prepare(gameID: UUID, operation: UInt64) async {
        do {
            guard let token = try loadSession(), !token.isEmpty else {
                throw AudioSessionClientError.noApplicationSession
            }
            applicationSession = token
            let session: AudioSessionProjection
            let current = try await sessionClient.current(gameID: gameID)
            guard operation == operationGeneration, state != .stopped else {
                if let current {
                    let ended = await retainAndReconcileEnd(
                        gameID: gameID, audioSessionID: current.audioSessionId,
                        mayBeAbsent: false
                    )
                    if !ended { state = .stopPending(.unavailable) }
                }
                return
            }
            if let current {
                guard [.starting, .interrupted].contains(current.state) else {
                    throw SharedAudioFailure.unavailable
                }
                session = current
            } else {
                let audioSessionID = UUID()
                do {
                    session = try await sessionClient.open(
                        gameID: gameID, audioSessionID: audioSessionID, requestID: UUID()
                    )
                } catch {
                    if operation != operationGeneration || state == .stopped {
                        let ended = await retainAndReconcileEnd(
                            gameID: gameID, audioSessionID: audioSessionID, mayBeAbsent: true
                        )
                        if !ended { state = .stopPending(.unavailable) }
                        return
                    }
                    throw error
                }
                guard operation == operationGeneration, state != .stopped else {
                    let ended = await retainAndReconcileEnd(
                        gameID: gameID, audioSessionID: session.audioSessionId,
                        mayBeAbsent: false
                    )
                    if !ended { state = .stopPending(.unavailable) }
                    return
                }
            }
            guard operation == operationGeneration, state != .stopped else { return }
            retainedSession = session
            guard capturePermission.prepareCaptureAttempt() == .ready else {
                throw SharedAudioFailure.unavailable
            }
            try await establish(session: session, token: token, operation: operation)
        } catch let failure as SharedAudioFailure {
            if operation == operationGeneration, state != .stopped {
                beginRecovery(after: failure)
            }
        } catch {
            if operation == operationGeneration, state != .stopped {
                teardownTransport()
                retainedCounters.terminalFailures += 1
                state = .interrupted(.unavailable)
            }
        }
    }

    public func reconnect() {
        guard case .interrupted = state else { return }
        guard retainedSession != nil, applicationSession != nil else {
            guard let gameID else { return }
            Task { [weak self] in
                await self?.beginPrepare(gameID: gameID, resetCounters: false)
            }
            return
        }
        operationGeneration &+= 1
        beginRecovery(after: .interrupted)
    }

    public func stop() async {
        if case .stopPending = state {
            if await reconcilePendingEnd() { state = .stopped }
            return
        }
        if state != .stopped {
            operationGeneration &+= 1
            recoveryTask?.cancel()
            recoveryTask = nil
            playbackGate(false)
            if let session = retainedSession, let gameID {
                _ = retainEndIntent(
                    gameID: gameID, audioSessionID: session.audioSessionId,
                    mayBeAbsent: false
                )
            }
            teardownTransport()
            state = .stopped
        }
        if pendingEndIntent != nil && !endIntentPersisted {
            state = .stopPending(.unavailable)
            return
        }
        if !(await reconcilePendingEnd()) { state = .stopPending(.unavailable) }
    }

    @discardableResult
    private func retainEndIntent(
        gameID: UUID, audioSessionID: UUID, mayBeAbsent: Bool
    ) -> Bool {
        do {
            if pendingEndIntent == nil {
                pendingEndIntent = try loadEndIntent()
                endIntentPersisted = pendingEndIntent != nil
            }
            if let pendingEndIntent {
                return pendingEndIntent.gameID == gameID
                    && pendingEndIntent.audioSessionID == audioSessionID
                    && endIntentPersisted
            }
            let intent = HostPendingAudioEnd(
                gameID: gameID, audioSessionID: audioSessionID,
                requestID: UUID(), mayBeAbsent: mayBeAbsent
            )
            pendingEndIntent = intent
            try saveEndIntent(intent)
            endIntentPersisted = true
            return true
        } catch {
            return false
        }
    }

    private func retainAndReconcileEnd(
        gameID: UUID, audioSessionID: UUID, mayBeAbsent: Bool
    ) async -> Bool {
        guard retainEndIntent(
            gameID: gameID, audioSessionID: audioSessionID, mayBeAbsent: mayBeAbsent
        ) else { return false }
        return await reconcilePendingEnd()
    }

    private func reconcilePendingEnd() async -> Bool {
        do {
            if pendingEndIntent == nil {
                pendingEndIntent = try loadEndIntent()
                endIntentPersisted = pendingEndIntent != nil
            }
            guard let intent = pendingEndIntent else { return true }
            if !endIntentPersisted {
                try saveEndIntent(intent)
                endIntentPersisted = true
            }
            do {
                let ended = try await sessionClient.end(
                    gameID: intent.gameID, audioSessionID: intent.audioSessionID,
                    requestID: intent.requestID
                )
                guard ended.state == .ended else { return false }
            } catch AudioSessionClientError.server(.audioSessionNotFound)
                where intent.mayBeAbsent {
                // A canceled open that definitively never committed needs no terminal edge.
            } catch {
                return false
            }
            try clearEndIntent()
            pendingEndIntent = nil
            endIntentPersisted = false
            if retainedSession?.audioSessionId == intent.audioSessionID {
                retainedSession = nil
            }
            return true
        } catch {
            return false
        }
    }

    public var counters: SharedAudioCounters {
        let preIngest = forwarder?.droppedBeforeIngest() ?? (0, 0)
        return SharedAudioCounters(
            capturedFrames: retainedCounters.capturedFrames + (capture?.capturedFrames ?? 0),
            captureDroppedPackets: retainedCounters.captureDroppedPackets
                + (capture?.droppedPackets ?? 0),
            captureDroppedFrames: retainedCounters.captureDroppedFrames
                + (capture?.droppedFrames ?? 0),
            preIngestDroppedPackets: retainedCounters.preIngestDroppedPackets
                + preIngest.0,
            preIngestDroppedFrames: retainedCounters.preIngestDroppedFrames + preIngest.1,
            uploadDroppedPackets: retainedCounters.uploadDroppedPackets
                + (ingest?.droppedPackets ?? 0),
            uploadDroppedFrames: retainedCounters.uploadDroppedFrames
                + (ingest?.droppedFrames ?? 0),
            uploadQueuedPackets: ingest?.queuedPackets ?? 0,
            playerDroppedPackets: retainedCounters.playerDroppedPackets
                + (player?.droppedPackets ?? 0),
            playerDroppedFrames: retainedCounters.playerDroppedFrames
                + (player?.droppedFrames ?? 0),
            playerQueuedPackets: player?.queuedPackets ?? 0,
            discontinuities: retainedCounters.discontinuities,
            reconnectAttempts: retainedCounters.reconnectAttempts,
            terminalFailures: retainedCounters.terminalFailures
        )
    }

    private func establish(
        session: AudioSessionProjection, token: String, operation: UInt64
    ) async throws {
        teardownTransport()
        guard operation == operationGeneration, state != .stopped else {
            throw SharedAudioFailure.interrupted
        }
        let transport = transportGeneration
        let startupFence = StartupFence()
        transportFence = startupFence
        let identity = SharedAudioStreamIdentity(
            gameID: session.gameId, audioSessionID: session.audioSessionId,
            generation: session.generation
        )
        let forwarder = AudioPacketForwarder()
        let capture = captureFactory()
        do {
            try capture.start { [weak forwarder] packet in forwarder?.forward(packet) }
            capturePermission.recordCaptureResult(.ready)
        } catch {
            capturePermission.recordCaptureResult(.failed)
            throw error
        }
        let ingest = try ingestFactory(identity, token, capture.sampleRate)
        forwarder.install(ingest)
        self.forwarder = forwarder
        self.capture = capture
        self.ingest = ingest
        let ingestReady = StartupSignal<Void>()
        ingest.start { [weak self, weak ingestReady] event in
            switch event {
            case .active: ingestReady?.resolve(.success(()))
            case .interrupted(let failure):
                startupFence.fail(failure)
                ingestReady?.resolve(.failure(failure))
            case .connecting: break
            }
            Task { @MainActor [weak self] in self?.ingestEvent(event, transport: transport) }
        }
        try await wait(ingestReady, timeout: .seconds(6))
        try startupFence.requireHealthy()
        guard operation == operationGeneration, transport == transportGeneration,
              state != .stopped else { throw SharedAudioFailure.interrupted }

        let player = playerFactory()
        let listener = try listenerFactory(identity, token)
        self.player = player
        self.listener = listener
        let listenerReady = StartupSignal<Int>()
        listener.start(report: { [weak self, weak listenerReady, weak player] event in
            switch event {
            case .active(let sampleRate):
                do {
                    try startupFence.requireHealthy()
                    guard let player else { throw SharedAudioFailure.unavailable }
                    try player.start(sampleRate: sampleRate)
                    listenerReady?.resolve(.success(sampleRate))
                } catch {
                    listenerReady?.resolve(.failure(SharedAudioFailure.unavailable))
                }
            case .interrupted(let failure):
                startupFence.fail(failure)
                listenerReady?.resolve(.failure(failure))
            case .connecting: break
            }
            Task { @MainActor [weak self] in self?.listenerEvent(event, transport: transport) }
        }, consume: { [weak player] packet in
            guard (try? startupFence.requireHealthy()) != nil else { return }
            _ = player?.append(interleavedInt16: packet)
        })
        let listenerRate = try await wait(listenerReady, timeout: .seconds(6))
        try startupFence.requireHealthy()
        guard operation == operationGeneration, transport == transportGeneration,
              state != .stopped else { throw SharedAudioFailure.interrupted }
        guard listenerRate == capture.sampleRate else { throw SharedAudioFailure.invalidFormat }
        guard operation == operationGeneration, transport == transportGeneration,
              state != .stopped else {
            teardownTransport()
            throw SharedAudioFailure.interrupted
        }
        state = .active(identity)
        playbackGate(true)
    }

    private func wait<Value: Sendable>(
        _ signal: StartupSignal<Value>, timeout: Duration
    ) async throws -> Value {
        let timeoutTask = Task {
            await sleep(timeout)
            if !Task.isCancelled { signal.resolve(.failure(SharedAudioFailure.unavailable)) }
        }
        defer { timeoutTask.cancel() }
        return try await signal.wait(timeout: timeout)
    }

    private func ingestEvent(_ event: AudioIngestEvent, transport: UInt64) {
        guard transport == transportGeneration else { return }
        guard case .active = state else { return }
        if case .interrupted(let failure) = event { beginRecovery(after: failure) }
    }

    private func listenerEvent(_ event: AudioListenerEvent, transport: UInt64) {
        guard transport == transportGeneration else { return }
        guard case .active = state else { return }
        if case .interrupted(let failure) = event { beginRecovery(after: failure) }
    }

    private func beginRecovery(after failure: SharedAudioFailure) {
        guard recoveryTask == nil else { return }
        retainedCounters.discontinuities += 1
        let operation = operationGeneration
        playbackGate(false)
        teardownTransport()
        guard let session = retainedSession, let token = applicationSession else {
            retainedCounters.terminalFailures += 1
            state = .interrupted(failure)
            return
        }
        recoveryTask = Task { [weak self] in
            guard let self else { return }
            let delays: [Duration] = [.seconds(1), .seconds(2), .seconds(4)]
            for (index, delay) in delays.enumerated() {
                if Task.isCancelled || operation != self.operationGeneration { return }
                self.retainedCounters.reconnectAttempts += 1
                self.state = .reconnecting(attempt: index + 1)
                await self.sleep(delay)
                if Task.isCancelled || operation != self.operationGeneration { return }
                do {
                    guard let gameID = self.gameID else {
                        throw SharedAudioFailure.unavailable
                    }
                    let current = try await self.sessionClient.current(gameID: gameID)
                    guard !Task.isCancelled, operation == self.operationGeneration,
                          ![.stopped, .stopPending(.unavailable)].contains(self.state),
                          let current,
                          current.audioSessionId == session.audioSessionId,
                          current.generation == session.generation,
                          [.starting, .interrupted].contains(current.state) else {
                        throw SharedAudioFailure.unavailable
                    }
                    self.retainedSession = current
                    try await self.establish(
                        session: current, token: token, operation: operation
                    )
                    self.recoveryTask = nil
                    return
                } catch {
                    self.teardownTransport()
                }
            }
            guard !Task.isCancelled, operation == self.operationGeneration else { return }
            self.retainedCounters.terminalFailures += 1
            self.state = .interrupted(failure)
            self.recoveryTask = nil
        }
    }

    private func teardownTransport() {
        transportGeneration &+= 1
        transportFence?.fail(.interrupted)
        transportFence = nil
        forwarder?.clear()
        let capturedFrames = capture?.capturedFrames ?? 0
        let captureDroppedPackets = capture?.droppedPackets ?? 0
        let captureDroppedFrames = capture?.droppedFrames ?? 0
        let preIngest = forwarder?.droppedBeforeIngest() ?? (0, 0)
        let uploadDroppedPackets = ingest?.droppedPackets ?? 0
        let uploadDroppedFrames = ingest?.droppedFrames ?? 0
        let playerDroppedPackets = player?.droppedPackets ?? 0
        let playerDroppedFrames = player?.droppedFrames ?? 0
        listener?.stop()
        ingest?.stop()
        capture?.stop()
        player?.stop()
        retainedCounters.capturedFrames += capturedFrames
        retainedCounters.captureDroppedPackets += captureDroppedPackets
        retainedCounters.captureDroppedFrames += captureDroppedFrames
        retainedCounters.preIngestDroppedPackets += preIngest.0
        retainedCounters.preIngestDroppedFrames += preIngest.1
        retainedCounters.uploadDroppedPackets += uploadDroppedPackets
        retainedCounters.uploadDroppedFrames += uploadDroppedFrames
        retainedCounters.playerDroppedPackets += playerDroppedPackets
        retainedCounters.playerDroppedFrames += playerDroppedFrames
        forwarder = nil
        listener = nil
        ingest = nil
        capture = nil
        player = nil
    }

    deinit { recoveryTask?.cancel() }
}
