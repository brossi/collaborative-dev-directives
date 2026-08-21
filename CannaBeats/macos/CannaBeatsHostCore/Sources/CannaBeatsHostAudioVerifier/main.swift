import AudioTapBridge
import CannaBeatsHostCore
import Foundation

enum VerificationFailure: Error {
    case invariant(String)
}

func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    guard condition() else { throw VerificationFailure.invariant(message) }
}

func samples(frames: Int, channels: Int = 2) -> [Float] {
    Array(repeating: 0.25, count: frames * channels)
}

do {
    guard let boundary = CBPCMFrameRing(slotCount: 4, maximumFramesPerSlot: 4_096) else {
        throw VerificationFailure.invariant("ring allocation")
    }
    let below = samples(frames: 4_095)
    try below.withUnsafeBufferPointer {
        try require(boundary.enqueueInterleavedFloatSamples(
            $0.baseAddress!, frames: 4_095, channels: 2
        ), "4,095 frames")
    }
    try require(boundary.dequeuePacket()?.count == 4_095 * 4, "4,095 byte projection")
    let exact = samples(frames: 4_096)
    try exact.withUnsafeBufferPointer {
        try require(boundary.enqueueInterleavedFloatSamples(
            $0.baseAddress!, frames: 4_096, channels: 2
        ), "4,096 frames")
    }
    try require(boundary.dequeuePacket()?.count == 4_096 * 4, "4,096 byte projection")
    let above = samples(frames: 4_097)
    try above.withUnsafeBufferPointer {
        try require(!boundary.enqueueInterleavedFloatSamples(
            $0.baseAddress!, frames: 4_097, channels: 2
        ), "4,097 rejection")
    }
    try require(boundary.droppedPackets == 1, "oversized packet count")
    try require(boundary.droppedFrames == 4_097, "oversized frame count")

    for capacity in [63, 64, 65] {
        guard let ring = CBPCMFrameRing(slotCount: 64, maximumFramesPerSlot: 1) else {
            throw VerificationFailure.invariant("capacity ring allocation")
        }
        let sample: [Float] = [0.5, -0.5]
        var accepted = 0
        for _ in 0..<capacity {
            let result = sample.withUnsafeBufferPointer {
                ring.enqueueInterleavedFloatSamples($0.baseAddress!, frames: 1, channels: 2)
            }
            if result { accepted += 1 }
        }
        try require(accepted == min(capacity, 64), "\(capacity) accepted")
        try require(ring.queuedPacketCount == UInt32(min(capacity, 64)), "\(capacity) queued")
        try require(ring.droppedPackets == UInt64(max(0, capacity - 64)), "\(capacity) dropped")
    }

    guard let conversion = CBPCMFrameRing(slotCount: 1, maximumFramesPerSlot: 2) else {
        throw VerificationFailure.invariant("conversion ring allocation")
    }
    let mono: [Float] = [-2, 2]
    try mono.withUnsafeBufferPointer {
        try require(conversion.enqueueInterleavedFloatSamples(
            $0.baseAddress!, frames: 2, channels: 1
        ), "mono conversion")
    }
    guard let packet = conversion.dequeuePacket() else {
        throw VerificationFailure.invariant("conversion packet")
    }
    let converted = packet.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
    try require(converted == [-32_767, -32_767, 32_767, 32_767], "clamp and stereo mixdown")

} catch {
    fputs("CannaBeats Host audio verifier failed: \(error)\n", stderr)
    exit(1)
}

private actor AudioControlTransport {
    let gameID: UUID
    let sessionID: UUID
    private var requests: [URLRequest] = []

    init(gameID: UUID, sessionID: UUID) {
        self.gameID = gameID
        self.sessionID = sessionID
    }

    func send(_ request: URLRequest) throws -> (Data, URLResponse) {
        requests.append(request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil
        )!
        let path = request.url!.path
        if path.hasSuffix("/current") {
            return (Data(#"{"code":"idle"}"#.utf8), response)
        }
        let ended = path.hasSuffix("/end")
        let object: [String: Any] = [
            "code": ended ? "ended" : "audio_session",
            "session": [
                "audioSessionId": sessionID.uuidString.lowercased(),
                "connectionId": NSNull(),
                "gameId": gameID.uuidString.lowercased(),
                "generation": 1,
                "state": ended ? "ended" : "starting",
                "updatedAt": ended ? 2_001 : 2_000,
            ],
        ]
        return (try JSONSerialization.data(withJSONObject: object), response)
    }

    func retainedRequests() -> [URLRequest] { requests }
}

private func verifyAudioControlClient() async throws {
    let gameID = UUID()
    let sessionID = UUID()
    let openRequestID = UUID()
    let endRequestID = UUID()
    let transport = AudioControlTransport(gameID: gameID, sessionID: sessionID)
    let client = AudioSessionClient(
        transport: { try await transport.send($0) },
        loadSession: { "abcdefghijklmnopqrstuvwx" }
    )
    let current = try await client.current(gameID: gameID)
    try require(current == nil, "idle control projection")
    let opened = try await client.open(
        gameID: gameID, audioSessionID: sessionID, requestID: openRequestID
    )
    try require(opened.state == .starting && opened.generation == 1, "open control projection")
    let ended = try await client.end(
        gameID: gameID, audioSessionID: sessionID, requestID: endRequestID
    )
    try require(ended.state == .ended, "end control projection")
    let requests = await transport.retainedRequests()
    try require(requests.count == 3, "control request count")
    try require(requests.allSatisfy {
        $0.value(forHTTPHeaderField: AudioSessionClient.contractHeader) == "1"
            && $0.value(forHTTPHeaderField: "Authorization")
                == "Bearer abcdefghijklmnopqrstuvwx"
    }, "control authority headers")
    let openBody = try JSONSerialization.jsonObject(with: requests[1].httpBody!) as! [String: Any]
    try require(Set(openBody.keys) == ["audioSessionId", "requestId"]
        && openBody["audioSessionId"] as? String == sessionID.uuidString.lowercased()
        && openBody["requestId"] as? String == openRequestID.uuidString.lowercased(),
        "exact open body")
    let endBody = try JSONSerialization.jsonObject(with: requests[2].httpBody!) as! [String: Any]
    try require(Set(endBody.keys) == ["requestId"]
        && endBody["requestId"] as? String == endRequestID.uuidString.lowercased(),
        "exact end body")

    let malformed = AudioSessionClient(
        transport: { request in
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil
            )!
            return (Data(#"{"code":"audio_session","session":{"audioSessionId":"00000000-0000-4000-8000-000000000000","connectionId":"00000000-0000-4000-8000-000000000001","gameId":"00000000-0000-4000-8000-000000000002","generation":1,"state":"starting","updatedAt":1}}"#.utf8), response)
        },
        loadSession: { "abcdefghijklmnopqrstuvwx" }
    )
    do {
        _ = try await malformed.current(gameID: UUID(uuidString: "00000000-0000-4000-8000-000000000002")!)
        throw VerificationFailure.invariant("malformed starting head accepted")
    } catch AudioSessionClientError.invalidResponse {
        // Expected finite rejection.
    }
}

private func verifyBoundedStreamingProtocol() throws {
    for capacity in [63, 64, 65] {
        let buffer = BoundedPCMUploadBuffer()
        for index in 0..<capacity {
            try require(buffer.enqueue(Data([UInt8(index % 255), 0, 0, 0])),
                        "upload packet \(index)")
        }
        try require(buffer.count == min(capacity, 64), "upload capacity \(capacity)")
        try require(buffer.droppedPackets == UInt64(max(0, capacity - 64)),
                    "upload drops \(capacity)")
        if capacity == 65 {
            try require(buffer.dequeue()?.first == 1, "upload drops oldest packet")
            try require(buffer.droppedFrames == 1, "upload dropped frame accounting")
        }
    }
    let invalid = BoundedPCMUploadBuffer()
    try require(!invalid.enqueue(Data([1, 2, 3])), "misaligned upload rejected")
    try require(!invalid.enqueue(Data(repeating: 0, count: sharedAudioPacketByteLimit + 4)),
                "oversized upload rejected")
    let concurrent = BoundedPCMUploadBuffer(capacity: 8)
    DispatchQueue.concurrentPerform(iterations: 2_000) { index in
        if index.isMultiple(of: 2) {
            _ = concurrent.enqueue(Data([UInt8(index % 255), 0, 0, 0]))
        } else {
            _ = concurrent.droppedPackets
            _ = concurrent.droppedFrames
        }
    }
    try require(concurrent.count <= 8 && concurrent.droppedPackets == 992
                && concurrent.droppedFrames == 992,
                "concurrent upload counters remain locked and exact")

    let sessionID = UUID()
    let header = Data("""
    HTTP/1.1 200 OK\r
    content-type: application/octet-stream\r
    transfer-encoding: chunked\r
    x-cannabeats-audio-contract: 1\r
    x-cannabeats-audio-session: \(sessionID.uuidString.lowercased())\r
    x-cannabeats-audio-generation: 7\r
    x-cannabeats-audio-rate: 48000\r
    x-cannabeats-audio-channels: 2\r
    x-cannabeats-audio-encoding: s16le\r
    \r
    4\r

    """.utf8)
    let parsed = try SharedAudioResponseHead.parse(
        header, expectedSessionID: sessionID, expectedGeneration: 7
    )
    try require(parsed.head.sampleRate == 48_000, "strict response rate")
    try require(parsed.bodyRemainder == Data("4\r\n".utf8), "response body split")
    do {
        _ = try SharedAudioResponseHead.parse(
            header, expectedSessionID: sessionID, expectedGeneration: 8
        )
        throw VerificationFailure.invariant("wrong response generation accepted")
    } catch SharedAudioFailure.invalidResponse {
        // Expected.
    }

    let decoder = BoundedHTTPChunkDecoder()
    let partial = try decoder.append(Data("4\r\n12".utf8))
    try require(partial.isEmpty, "split chunk retained")
    let chunks = try decoder.append(Data("34\r\n3\r\nabc\r\n0\r\n\r\n".utf8))
    try require(chunks == [Data("1234".utf8), Data("abc".utf8)], "chunk projection")
    try require(decoder.isTerminal, "chunk terminal")
    do {
        _ = try decoder.append(Data([1]))
        throw VerificationFailure.invariant("post-terminal bytes accepted")
    } catch SharedAudioFailure.invalidResponse {
        // Expected.
    }
}

private final class AudioOrderLog: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []
    func add(_ value: String) { lock.withLock { values.append(value) } }
    func snapshot() -> [String] { lock.withLock { values } }
}

private actor FakeAudioSessions: AudioSessionControlling {
    let gameID: UUID
    let sessionID: UUID
    private var currentCalls = 0
    private(set) var endCalls = 0

    init(gameID: UUID, sessionID: UUID) {
        self.gameID = gameID
        self.sessionID = sessionID
    }

    func current(gameID: UUID) async throws -> AudioSessionProjection? {
        currentCalls += 1
        return AudioSessionProjection(
            audioSessionId: sessionID, connectionId: nil, gameId: self.gameID,
            generation: 1, state: currentCalls == 1 ? .starting : .interrupted,
            updatedAt: Int64(2_000 + currentCalls)
        )
    }

    func open(
        gameID: UUID, audioSessionID: UUID, requestID: UUID
    ) async throws -> AudioSessionProjection {
        throw VerificationFailure.invariant("unexpected audio open")
    }

    func end(
        gameID: UUID, audioSessionID: UUID, requestID: UUID
    ) async throws -> AudioSessionProjection {
        endCalls += 1
        return AudioSessionProjection(
            audioSessionId: sessionID, connectionId: nil, gameId: self.gameID,
            generation: 1, state: .ended, updatedAt: 3_000
        )
    }

    func endedCount() -> Int { endCalls }
}

private actor RecoverableAudioSessions: AudioSessionControlling {
    let gameID: UUID
    let sessionID: UUID
    private var currentCalls = 0

    init(gameID: UUID, sessionID: UUID) {
        self.gameID = gameID
        self.sessionID = sessionID
    }

    func current(gameID: UUID) async throws -> AudioSessionProjection? {
        currentCalls += 1
        if currentCalls == 1 { throw SharedAudioFailure.unavailable }
        return AudioSessionProjection(
            audioSessionId: sessionID, connectionId: nil, gameId: self.gameID,
            generation: 1, state: .starting, updatedAt: 2_000
        )
    }

    func open(
        gameID: UUID, audioSessionID: UUID, requestID: UUID
    ) async throws -> AudioSessionProjection {
        throw VerificationFailure.invariant("unexpected recovery open")
    }

    func end(
        gameID: UUID, audioSessionID: UUID, requestID: UUID
    ) async throws -> AudioSessionProjection {
        AudioSessionProjection(
            audioSessionId: sessionID, connectionId: nil, gameId: self.gameID,
            generation: 1, state: .ended, updatedAt: 3_000
        )
    }
}

private final class EndIntentMemory: @unchecked Sendable {
    private let lock = NSLock()
    private var retained: HostPendingAudioEnd?
    func load() -> HostPendingAudioEnd? { lock.withLock { retained } }
    func save(_ value: HostPendingAudioEnd) { lock.withLock { retained = value } }
    func clear() { lock.withLock { retained = nil } }
}

private enum EndIntentMemoryFailure: Error { case unavailable }

private final class FlakyEndIntentMemory: @unchecked Sendable {
    private let lock = NSLock()
    private var retained: HostPendingAudioEnd?
    private var failuresRemaining = 1
    func load() -> HostPendingAudioEnd? { lock.withLock { retained } }
    func save(_ value: HostPendingAudioEnd) throws {
        try lock.withLock {
            if failuresRemaining > 0 {
                failuresRemaining -= 1
                throw EndIntentMemoryFailure.unavailable
            }
            retained = value
        }
    }
    func clear() { lock.withLock { retained = nil } }
}

private actor OutcomeUnknownAudioSessions: AudioSessionControlling {
    enum FirstEnd { case beforeCommit, afterCommit }
    let gameID: UUID
    let sessionID: UUID
    private let firstEnd: FirstEnd
    private var first = true
    private var ended = false
    private var requests: [UUID] = []
    private var events: [String] = []

    init(gameID: UUID, sessionID: UUID, firstEnd: FirstEnd) {
        self.gameID = gameID
        self.sessionID = sessionID
        self.firstEnd = firstEnd
    }

    func current(gameID: UUID) async throws -> AudioSessionProjection? {
        events.append("current")
        guard !ended else { return nil }
        return AudioSessionProjection(
            audioSessionId: sessionID, connectionId: nil, gameId: self.gameID,
            generation: 1, state: .starting, updatedAt: 2_000
        )
    }

    func open(
        gameID: UUID, audioSessionID: UUID, requestID: UUID
    ) async throws -> AudioSessionProjection {
        events.append("open")
        throw SharedAudioFailure.unavailable
    }

    func end(
        gameID: UUID, audioSessionID: UUID, requestID: UUID
    ) async throws -> AudioSessionProjection {
        events.append("end")
        requests.append(requestID)
        if first {
            first = false
            if firstEnd == .afterCommit { ended = true }
            throw AudioSessionClientError.responseLost
        }
        ended = true
        return AudioSessionProjection(
            audioSessionId: sessionID, connectionId: nil, gameId: self.gameID,
            generation: 1, state: .ended, updatedAt: 3_000
        )
    }

    func evidence() -> (requests: [UUID], events: [String]) { (requests, events) }
}

private actor SuspendedCurrentAudioSessions: AudioSessionControlling {
    let gameID: UUID
    let sessionID: UUID
    private var continuation: CheckedContinuation<AudioSessionProjection?, Never>?
    private var started = false
    private var ends = 0

    init(gameID: UUID, sessionID: UUID) { self.gameID = gameID; self.sessionID = sessionID }

    func current(gameID: UUID) async throws -> AudioSessionProjection? {
        started = true
        return await withCheckedContinuation { continuation = $0 }
    }
    func waitUntilStarted() async { while !started { await Task.yield() } }
    func resume() {
        continuation?.resume(returning: AudioSessionProjection(
            audioSessionId: sessionID, connectionId: nil, gameId: gameID,
            generation: 1, state: .starting, updatedAt: 2_000
        ))
        continuation = nil
    }
    func open(gameID: UUID, audioSessionID: UUID, requestID: UUID) async throws
        -> AudioSessionProjection { throw VerificationFailure.invariant("stale current opened") }
    func end(gameID: UUID, audioSessionID: UUID, requestID: UUID) async throws
        -> AudioSessionProjection {
        ends += 1
        return AudioSessionProjection(
            audioSessionId: sessionID, connectionId: nil, gameId: self.gameID,
            generation: 1, state: .ended, updatedAt: 3_000
        )
    }
    func endedCount() -> Int { ends }
}

private actor SuspendedOpenAudioSessions: AudioSessionControlling {
    let gameID: UUID
    private var continuation: CheckedContinuation<AudioSessionProjection, Never>?
    private var pendingSessionID: UUID?
    private var started = false
    private var ends = 0

    init(gameID: UUID) { self.gameID = gameID }
    func current(gameID: UUID) async throws -> AudioSessionProjection? { nil }
    func open(gameID: UUID, audioSessionID: UUID, requestID: UUID) async throws
        -> AudioSessionProjection {
        pendingSessionID = audioSessionID
        started = true
        return await withCheckedContinuation { continuation = $0 }
    }
    func waitUntilStarted() async { while !started { await Task.yield() } }
    func resume() {
        let sessionID = pendingSessionID!
        continuation?.resume(returning: AudioSessionProjection(
            audioSessionId: sessionID, connectionId: nil, gameId: gameID,
            generation: 1, state: .starting, updatedAt: 2_000
        ))
        continuation = nil
    }
    func end(gameID: UUID, audioSessionID: UUID, requestID: UUID) async throws
        -> AudioSessionProjection {
        ends += 1
        return AudioSessionProjection(
            audioSessionId: audioSessionID, connectionId: nil, gameId: self.gameID,
            generation: 1, state: .ended, updatedAt: 3_000
        )
    }
    func endedCount() -> Int { ends }
}

private actor SuspendedRecoveryAudioSessions: AudioSessionControlling {
    let gameID: UUID
    let sessionID: UUID
    private var calls = 0
    private var recoveryStarted = false
    private var continuation: CheckedContinuation<AudioSessionProjection?, Never>?

    init(gameID: UUID, sessionID: UUID) { self.gameID = gameID; self.sessionID = sessionID }
    func current(gameID: UUID) async throws -> AudioSessionProjection? {
        calls += 1
        if calls == 1 {
            return AudioSessionProjection(
                audioSessionId: sessionID, connectionId: nil, gameId: self.gameID,
                generation: 1, state: .starting, updatedAt: 2_000
            )
        }
        recoveryStarted = true
        return await withCheckedContinuation { continuation = $0 }
    }
    func waitUntilRecoveryCurrent() async {
        while !recoveryStarted { await Task.yield() }
    }
    func resumeRecoveryCurrent() {
        continuation?.resume(returning: AudioSessionProjection(
            audioSessionId: sessionID, connectionId: nil, gameId: gameID,
            generation: 1, state: .interrupted, updatedAt: 2_100
        ))
        continuation = nil
    }
    func open(gameID: UUID, audioSessionID: UUID, requestID: UUID) async throws
        -> AudioSessionProjection { throw VerificationFailure.invariant("unexpected open") }
    func end(gameID: UUID, audioSessionID: UUID, requestID: UUID) async throws
        -> AudioSessionProjection {
        AudioSessionProjection(
            audioSessionId: sessionID, connectionId: nil, gameId: self.gameID,
            generation: 1, state: .ended, updatedAt: 3_000
        )
    }
}

private final class FakeCapture: SharedAudioCapturing, @unchecked Sendable {
    let log: AudioOrderLog
    init(_ log: AudioOrderLog) { self.log = log }
    var sampleRate: Int { 48_000 }
    var capturedFrames: UInt64 { 4 }
    var droppedPackets: UInt64 { 0 }
    var droppedFrames: UInt64 { 0 }
    func start(packetHandler: @escaping @Sendable (Data) -> Void) throws {
        log.add("capture_start")
        packetHandler(Data([1, 2, 3, 4]))
    }
    func stop() { log.add("capture_stop") }
}

private final class FakeIngest: SharedAudioIngesting, @unchecked Sendable {
    let log: AudioOrderLog
    private let lock = NSLock()
    private var reporter: (@Sendable (AudioIngestEvent) -> Void)?
    init(_ log: AudioOrderLog) { self.log = log }
    var droppedPackets: UInt64 { 0 }
    var droppedFrames: UInt64 { 0 }
    var queuedPackets: Int { 0 }
    func start(report: @escaping @Sendable (AudioIngestEvent) -> Void) {
        lock.withLock { reporter = report }
        log.add("ingest_start")
        report(.connecting)
        report(.active)
    }
    func enqueue(_ packet: Data) -> Bool { log.add("ingest_enqueue"); return true }
    func stop() { log.add("ingest_stop") }
    func interrupt() { lock.withLock { reporter }?(.interrupted(.interrupted)) }
}

private final class ImmediateInterruptIngest: SharedAudioIngesting, @unchecked Sendable {
    var droppedPackets: UInt64 { 0 }
    var droppedFrames: UInt64 { 0 }
    var queuedPackets: Int { 0 }
    func start(report: @escaping @Sendable (AudioIngestEvent) -> Void) {
        report(.active)
        report(.interrupted(.interrupted))
    }
    func enqueue(_ packet: Data) -> Bool { true }
    func stop() {}
}

private final class BlockingIngest: SharedAudioIngesting, @unchecked Sendable {
    private let lock = NSLock()
    private var reporter: (@Sendable (AudioIngestEvent) -> Void)?
    var droppedPackets: UInt64 { 0 }
    var droppedFrames: UInt64 { 0 }
    var queuedPackets: Int { 0 }
    var started: Bool { lock.withLock { reporter != nil } }
    func start(report: @escaping @Sendable (AudioIngestEvent) -> Void) {
        lock.withLock { reporter = report }
        report(.connecting)
    }
    func activate() { lock.withLock { reporter }?(.active) }
    func enqueue(_ packet: Data) -> Bool { true }
    func stop() {}
}

private final class FakeListener: SharedAudioListening, @unchecked Sendable {
    let log: AudioOrderLog
    init(_ log: AudioOrderLog) { self.log = log }
    func start(
        report: @escaping @Sendable (AudioListenerEvent) -> Void,
        consume: @escaping @Sendable (Data) -> Void
    ) {
        log.add("listener_start")
        report(.connecting)
        report(.active(sampleRate: 48_000))
        consume(Data([1, 2, 3, 4]))
    }
    func stop() { log.add("listener_stop") }
}

private final class BlockingListener: SharedAudioListening, @unchecked Sendable {
    private let lock = NSLock()
    private var reporter: (@Sendable (AudioListenerEvent) -> Void)?
    var started: Bool { lock.withLock { reporter != nil } }
    func start(
        report: @escaping @Sendable (AudioListenerEvent) -> Void,
        consume: @escaping @Sendable (Data) -> Void
    ) {
        lock.withLock { reporter = report }
        report(.connecting)
    }
    func activate() { lock.withLock { reporter }?(.active(sampleRate: 48_000)) }
    func stop() {}
}

private final class FakePlayer: SharedAudioPlaying, @unchecked Sendable {
    let log: AudioOrderLog
    init(_ log: AudioOrderLog) { self.log = log }
    var queuedPackets: Int { 0 }
    var droppedPackets: UInt64 { 0 }
    var droppedFrames: UInt64 { 0 }
    func start(sampleRate: Int) throws { log.add("player_start") }
    func append(interleavedInt16 data: Data) -> Bool { log.add("player_append"); return true }
    func stop() { log.add("player_stop") }
}

private final class FakeIngestRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [FakeIngest] = []
    func add(_ value: FakeIngest) { lock.withLock { values.append(value) } }
    func first() -> FakeIngest? { lock.withLock { values.first } }
    func value(at index: Int) -> FakeIngest? {
        lock.withLock { values.indices.contains(index) ? values[index] : nil }
    }
    var count: Int { lock.withLock { values.count } }
}

private struct ReadyCapturePermission: AudioCaptureAuthorizing {
    func readiness() -> AudioCaptureReadiness { .ready }
    func prepareCaptureAttempt() -> AudioCaptureReadiness { .ready }
    func recordCaptureResult(_ result: AudioCaptureReadiness) {}
}

private final class PermissionMemory: @unchecked Sendable {
    private let lock = NSLock()
    private var value: AudioCaptureReadiness?
    var result: AudioCaptureReadiness? {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

private func verifyCapturePermission() throws {
    let memory = PermissionMemory()
    let permission = SystemAudioCapturePermission(
        supported: { true }, loadResult: { memory.result }, saveResult: { memory.result = $0 }
    )
    try require(permission.readiness() == .notDetermined, "capture permission initial")
    try require(permission.prepareCaptureAttempt() == .ready, "capture attempt permitted")
    permission.recordCaptureResult(.failed)
    try require(permission.readiness() == .failed
                && permission.prepareCaptureAttempt() == .ready,
                "capture failure retained without blocking retry")
    permission.recordCaptureResult(.ready)
    try require(permission.readiness() == .ready, "capture success retained")
    let unsupported = SystemAudioCapturePermission(
        supported: { false }, loadResult: { .ready }, saveResult: { _ in }
    )
    try require(unsupported.readiness() == .unsupported, "capture permission unsupported")
}

@MainActor
private func verifySharedAudioOwner() async throws {
    let log = AudioOrderLog()
    let registry = FakeIngestRegistry()
    let gameID = UUID()
    let sessionID = UUID()
    let sessions = FakeAudioSessions(gameID: gameID, sessionID: sessionID)
    let owner = SharedAudioOwner(
        sessionClient: sessions,
        loadSession: { "abcdefghijklmnopqrstuvwx" },
        captureFactory: { FakeCapture(log) },
        ingestFactory: { _, _, _ in
            log.add("ingest_create")
            let ingest = FakeIngest(log)
            registry.add(ingest)
            return ingest
        },
        listenerFactory: { _, _ in log.add("listener_create"); return FakeListener(log) },
        playerFactory: { log.add("player_create"); return FakePlayer(log) },
        capturePermission: ReadyCapturePermission(),
        sleep: { _ in },
        playbackGate: { log.add($0 ? "gate_true" : "gate_false") }
    )
    await owner.start(gameID: gameID)
    try require(owner.state == .active(SharedAudioStreamIdentity(
        gameID: gameID, audioSessionID: sessionID, generation: 1
    )), "owner active identity")
    let order = log.snapshot()
    let requiredOrder = [
        "capture_start", "ingest_create", "ingest_start", "player_create",
        "listener_create", "listener_start", "player_start", "player_append", "gate_true",
    ]
    var cursor = 0
    for event in order where cursor < requiredOrder.count && event == requiredOrder[cursor] {
        cursor += 1
    }
    try require(cursor == requiredOrder.count, "capture-ingest-listen-playback order")
    try require(owner.counters.capturedFrames == 4, "owner capture counters")
    try require(owner.counters.preIngestDroppedPackets == 1
                && owner.counters.preIngestDroppedFrames == 1,
                "owner startup drop counters")
    await owner.stop()
    try require(owner.state == .stopped, "owner explicit stop")
    try require(owner.counters.capturedFrames == 4
                && owner.counters.preIngestDroppedPackets == 1,
                "owner counters survive teardown")
    let endedCount = await sessions.endedCount()
    try require(endedCount == 1, "owner retained end")

    let recoveryLog = AudioOrderLog()
    let recoveryRegistry = FakeIngestRegistry()
    let recoverySessions = FakeAudioSessions(gameID: gameID, sessionID: sessionID)
    let sleepLog = AudioOrderLog()
    let recovering = SharedAudioOwner(
        sessionClient: recoverySessions,
        loadSession: { "abcdefghijklmnopqrstuvwx" },
        captureFactory: { FakeCapture(recoveryLog) },
        ingestFactory: { _, _, _ in
            if recoveryRegistry.count > 0 {
                throw SharedAudioFailure.unavailable
            }
            let ingest = FakeIngest(recoveryLog)
            recoveryRegistry.add(ingest)
            return ingest
        },
        listenerFactory: { _, _ in FakeListener(recoveryLog) },
        playerFactory: { FakePlayer(recoveryLog) },
        capturePermission: ReadyCapturePermission(),
        sleep: { duration in sleepLog.add(String(describing: duration)) }
    )
    await recovering.start(gameID: gameID)
    recoveryRegistry.first()?.interrupt()
    for _ in 0..<100 where {
        if case .interrupted = recovering.state { return false }
        return true
    }() {
        await Task.yield()
    }
    guard case .interrupted = recovering.state else {
        throw VerificationFailure.invariant("recovery did not exhaust")
    }
    let sleeps = sleepLog.snapshot()
    let reconnectSleeps = sleeps.filter { $0 != String(describing: Duration.seconds(6)) }
    try require(reconnectSleeps == [
        String(describing: Duration.seconds(1)),
        String(describing: Duration.seconds(2)),
        String(describing: Duration.seconds(4)),
    ], "fixed recovery schedule")
    try require(recovering.counters.discontinuities == 1
                && recovering.counters.reconnectAttempts == 3
                && recovering.counters.terminalFailures == 1,
                "owner recovery counters")

    let recoveryStopMemory = EndIntentMemory()
    let suspendedRecoverySessions = SuspendedRecoveryAudioSessions(
        gameID: gameID, sessionID: sessionID
    )
    let recoveryStopRegistry = FakeIngestRegistry()
    let recoveryStopLog = AudioOrderLog()
    let recoveryStopOwner = SharedAudioOwner(
        sessionClient: suspendedRecoverySessions,
        loadSession: { "abcdefghijklmnopqrstuvwx" },
        captureFactory: { FakeCapture(recoveryStopLog) },
        ingestFactory: { _, _, _ in
            let ingest = FakeIngest(recoveryStopLog)
            recoveryStopRegistry.add(ingest)
            return ingest
        },
        listenerFactory: { _, _ in FakeListener(recoveryStopLog) },
        playerFactory: { FakePlayer(recoveryStopLog) },
        capturePermission: ReadyCapturePermission(), sleep: { _ in },
        loadEndIntent: { recoveryStopMemory.load() },
        saveEndIntent: { recoveryStopMemory.save($0) },
        clearEndIntent: { recoveryStopMemory.clear() }
    )
    await recoveryStopOwner.start(gameID: gameID)
    recoveryStopRegistry.first()?.interrupt()
    await suspendedRecoverySessions.waitUntilRecoveryCurrent()
    await recoveryStopOwner.stop()
    await suspendedRecoverySessions.resumeRecoveryCurrent()
    for _ in 0..<10 { await Task.yield() }
    try require(recoveryStopOwner.state == .stopped && recoveryStopRegistry.count == 1,
                "stop during recovery current cannot retain or publish a successor")

    let immediateLog = AudioOrderLog()
    let immediate = SharedAudioOwner(
        sessionClient: FakeAudioSessions(gameID: gameID, sessionID: sessionID),
        loadSession: { "abcdefghijklmnopqrstuvwx" },
        captureFactory: { FakeCapture(immediateLog) },
        ingestFactory: { _, _, _ in ImmediateInterruptIngest() },
        listenerFactory: { _, _ in FakeListener(immediateLog) },
        playerFactory: { FakePlayer(immediateLog) },
        capturePermission: ReadyCapturePermission(), sleep: { _ in },
        playbackGate: { immediateLog.add($0 ? "gate_true" : "gate_false") }
    )
    await immediate.start(gameID: gameID)
    for _ in 0..<100 where {
        if case .interrupted = immediate.state { return false }
        return true
    }() { await Task.yield() }
    guard case .interrupted = immediate.state else {
        throw VerificationFailure.invariant("startup interruption produced false readiness")
    }
    try require(!immediateLog.snapshot().contains("gate_true"),
                "startup interruption remains fenced")

    let fencingRegistry = FakeIngestRegistry()
    let fencingLog = AudioOrderLog()
    let fencing = SharedAudioOwner(
        sessionClient: FakeAudioSessions(gameID: gameID, sessionID: sessionID),
        loadSession: { "abcdefghijklmnopqrstuvwx" },
        captureFactory: { FakeCapture(fencingLog) },
        ingestFactory: { _, _, _ in
            let ingest = FakeIngest(fencingLog)
            fencingRegistry.add(ingest)
            return ingest
        },
        listenerFactory: { _, _ in FakeListener(fencingLog) },
        playerFactory: { FakePlayer(fencingLog) },
        capturePermission: ReadyCapturePermission(), sleep: { _ in }
    )
    await fencing.start(gameID: gameID)
    fencingRegistry.first()?.interrupt()
    for _ in 0..<100 where {
        if case .active = fencing.state, fencingRegistry.count >= 2 { return false }
        return true
    }() { await Task.yield() }
    guard case .active = fencing.state else {
        throw VerificationFailure.invariant("replacement transport did not activate")
    }
    fencingRegistry.first()?.interrupt()
    await Task.yield()
    guard case .active = fencing.state else {
        throw VerificationFailure.invariant("retired transport interrupted its successor")
    }

    let bootstrapSessions = RecoverableAudioSessions(gameID: gameID, sessionID: sessionID)
    let bootstrap = SharedAudioOwner(
        sessionClient: bootstrapSessions,
        loadSession: { "abcdefghijklmnopqrstuvwx" },
        captureFactory: { FakeCapture(AudioOrderLog()) },
        ingestFactory: { _, _, _ in FakeIngest(AudioOrderLog()) },
        listenerFactory: { _, _ in FakeListener(AudioOrderLog()) },
        playerFactory: { FakePlayer(AudioOrderLog()) },
        capturePermission: ReadyCapturePermission(), sleep: { _ in }
    )
    await bootstrap.start(gameID: gameID)
    guard case .interrupted = bootstrap.state else {
        throw VerificationFailure.invariant("bootstrap dependency failure was not finite")
    }
    bootstrap.reconnect()
    for _ in 0..<100 where {
        if case .active = bootstrap.state { return false }
        return true
    }() {
        await Task.yield()
    }
    guard case .active = bootstrap.state else {
        throw VerificationFailure.invariant("explicit bootstrap reconnect did not recover")
    }

    for firstEnd in [
        OutcomeUnknownAudioSessions.FirstEnd.beforeCommit,
        OutcomeUnknownAudioSessions.FirstEnd.afterCommit,
    ] {
        let memory = EndIntentMemory()
        let uncertainSessions = OutcomeUnknownAudioSessions(
            gameID: gameID, sessionID: sessionID, firstEnd: firstEnd
        )
        let firstLog = AudioOrderLog()
        let firstOwner = SharedAudioOwner(
            sessionClient: uncertainSessions,
            loadSession: { "abcdefghijklmnopqrstuvwx" },
            captureFactory: { FakeCapture(firstLog) },
            ingestFactory: { _, _, _ in FakeIngest(firstLog) },
            listenerFactory: { _, _ in FakeListener(firstLog) },
            playerFactory: { FakePlayer(firstLog) },
            capturePermission: ReadyCapturePermission(),
            loadEndIntent: { memory.load() }, saveEndIntent: { memory.save($0) },
            clearEndIntent: { memory.clear() }
        )
        await firstOwner.start(gameID: gameID)
        await firstOwner.stop()
        try require(firstOwner.state == .stopPending(.unavailable) && memory.load() != nil,
                    "unknown stop retains a durable end intent")

        let replacementLog = AudioOrderLog()
        let replacement = SharedAudioOwner(
            sessionClient: uncertainSessions,
            loadSession: { "abcdefghijklmnopqrstuvwx" },
            captureFactory: { FakeCapture(replacementLog) },
            ingestFactory: { _, _, _ in FakeIngest(replacementLog) },
            listenerFactory: { _, _ in FakeListener(replacementLog) },
            playerFactory: { FakePlayer(replacementLog) },
            capturePermission: ReadyCapturePermission(),
            loadEndIntent: { memory.load() }, saveEndIntent: { memory.save($0) },
            clearEndIntent: { memory.clear() }
        )
        await replacement.start(gameID: gameID)
        let evidence = await uncertainSessions.evidence()
        try require(evidence.requests.count == 2
                    && evidence.requests[0] == evidence.requests[1],
                    "unknown stop retries one stable request identity")
        try require(memory.load() == nil && evidence.events.prefix(3) == [
            "current", "end", "end",
        ], "restart reconciles the terminal intent before another current read")
        try require(!replacementLog.snapshot().contains("capture_start"),
                    "reconciled stop never resumes the old generation")
    }

    let flakyMemory = FlakyEndIntentMemory()
    let persistenceSessions = FakeAudioSessions(gameID: gameID, sessionID: sessionID)
    let persistenceLog = AudioOrderLog()
    let persistenceOwner = SharedAudioOwner(
        sessionClient: persistenceSessions,
        loadSession: { "abcdefghijklmnopqrstuvwx" },
        captureFactory: { FakeCapture(persistenceLog) },
        ingestFactory: { _, _, _ in FakeIngest(persistenceLog) },
        listenerFactory: { _, _ in FakeListener(persistenceLog) },
        playerFactory: { FakePlayer(persistenceLog) },
        capturePermission: ReadyCapturePermission(),
        loadEndIntent: { flakyMemory.load() }, saveEndIntent: { try flakyMemory.save($0) },
        clearEndIntent: { flakyMemory.clear() }
    )
    await persistenceOwner.start(gameID: gameID)
    await persistenceOwner.stop()
    let endCallsBeforePersistence = await persistenceSessions.endedCount()
    try require(persistenceOwner.state == .stopPending(.unavailable)
                && endCallsBeforePersistence == 0,
                "failed end-intent persistence blocks before an ambiguous end request")
    await persistenceOwner.stop()
    let endCallsAfterPersistence = await persistenceSessions.endedCount()
    try require(persistenceOwner.state == .stopped && endCallsAfterPersistence == 1,
                "explicit stop retry persists then terminalizes exactly once")

    let currentMemory = EndIntentMemory()
    let currentSessions = SuspendedCurrentAudioSessions(gameID: gameID, sessionID: sessionID)
    let currentLog = AudioOrderLog()
    let currentOwner = SharedAudioOwner(
        sessionClient: currentSessions,
        loadSession: { "abcdefghijklmnopqrstuvwx" },
        captureFactory: { FakeCapture(currentLog) },
        ingestFactory: { _, _, _ in FakeIngest(currentLog) },
        listenerFactory: { _, _ in FakeListener(currentLog) },
        playerFactory: { FakePlayer(currentLog) },
        capturePermission: ReadyCapturePermission(),
        loadEndIntent: { currentMemory.load() }, saveEndIntent: { currentMemory.save($0) },
        clearEndIntent: { currentMemory.clear() }
    )
    let currentStart = Task { await currentOwner.start(gameID: gameID) }
    await currentSessions.waitUntilStarted()
    await currentOwner.stop()
    await currentSessions.resume()
    await currentStart.value
    try require(currentOwner.state == .stopped && !currentLog.snapshot().contains("capture_start"),
                "stop during current fences native resource publication")
    let currentEndedCount = await currentSessions.endedCount()
    try require(currentEndedCount == 1,
                "stop during current terminalizes the discovered generation")

    let openMemory = EndIntentMemory()
    let openSessions = SuspendedOpenAudioSessions(gameID: gameID)
    let openLog = AudioOrderLog()
    let openOwner = SharedAudioOwner(
        sessionClient: openSessions,
        loadSession: { "abcdefghijklmnopqrstuvwx" },
        captureFactory: { FakeCapture(openLog) },
        ingestFactory: { _, _, _ in FakeIngest(openLog) },
        listenerFactory: { _, _ in FakeListener(openLog) },
        playerFactory: { FakePlayer(openLog) },
        capturePermission: ReadyCapturePermission(),
        loadEndIntent: { openMemory.load() }, saveEndIntent: { openMemory.save($0) },
        clearEndIntent: { openMemory.clear() }
    )
    let openStart = Task { await openOwner.start(gameID: gameID) }
    await openSessions.waitUntilStarted()
    await openOwner.stop()
    await openSessions.resume()
    await openStart.value
    try require(openOwner.state == .stopped && !openLog.snapshot().contains("capture_start"),
                "stop during open fences native resource publication")
    let openEndedCount = await openSessions.endedCount()
    try require(openEndedCount == 1,
                "stop during open terminalizes the committed generation")

    let ingestMemory = EndIntentMemory()
    let blockingIngest = BlockingIngest()
    let ingestStopLog = AudioOrderLog()
    let ingestStopOwner = SharedAudioOwner(
        sessionClient: FakeAudioSessions(gameID: gameID, sessionID: sessionID),
        loadSession: { "abcdefghijklmnopqrstuvwx" },
        captureFactory: { FakeCapture(ingestStopLog) },
        ingestFactory: { _, _, _ in blockingIngest },
        listenerFactory: { _, _ in FakeListener(ingestStopLog) },
        playerFactory: { ingestStopLog.add("player_create"); return FakePlayer(ingestStopLog) },
        capturePermission: ReadyCapturePermission(),
        loadEndIntent: { ingestMemory.load() }, saveEndIntent: { ingestMemory.save($0) },
        clearEndIntent: { ingestMemory.clear() }
    )
    let ingestStart = Task { await ingestStopOwner.start(gameID: gameID) }
    while !blockingIngest.started { await Task.yield() }
    await ingestStopOwner.stop()
    blockingIngest.activate()
    await ingestStart.value
    try require(ingestStopOwner.state == .stopped
                && !ingestStopLog.snapshot().contains("player_create"),
                "stop during ingest startup fences later resources")

    let listenerMemory = EndIntentMemory()
    let blockingListener = BlockingListener()
    let listenerStopLog = AudioOrderLog()
    let listenerStopOwner = SharedAudioOwner(
        sessionClient: FakeAudioSessions(gameID: gameID, sessionID: sessionID),
        loadSession: { "abcdefghijklmnopqrstuvwx" },
        captureFactory: { FakeCapture(listenerStopLog) },
        ingestFactory: { _, _, _ in FakeIngest(listenerStopLog) },
        listenerFactory: { _, _ in blockingListener },
        playerFactory: { FakePlayer(listenerStopLog) },
        capturePermission: ReadyCapturePermission(),
        playbackGate: { listenerStopLog.add($0 ? "gate_true" : "gate_false") },
        loadEndIntent: { listenerMemory.load() }, saveEndIntent: { listenerMemory.save($0) },
        clearEndIntent: { listenerMemory.clear() }
    )
    let listenerStart = Task { await listenerStopOwner.start(gameID: gameID) }
    while !blockingListener.started { await Task.yield() }
    await listenerStopOwner.stop()
    blockingListener.activate()
    await listenerStart.value
    try require(listenerStopOwner.state == .stopped
                && !listenerStopLog.snapshot().contains("player_start")
                && !listenerStopLog.snapshot().contains("gate_true"),
                "stop during listener startup fences player and readiness")
}

do {
    try await verifyAudioControlClient()
    try verifyBoundedStreamingProtocol()
    try verifyCapturePermission()
    try await verifySharedAudioOwner()
    print("CannaBeats Host audio verifier: 75 checks passed")
} catch {
    fputs("CannaBeats Host audio verifier failed: \(error)\n", stderr)
    exit(1)
}
