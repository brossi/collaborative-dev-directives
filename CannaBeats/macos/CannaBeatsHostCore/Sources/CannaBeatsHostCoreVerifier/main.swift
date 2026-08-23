import CannaBeatsHostCore
import CryptoKit
import Foundation

let deviceID = UUID(uuidString: "12345678-1234-4234-8234-123456789abc")!
let proof = try HostAuthorityProtocol.proofData(
    challenge: "ABCDEFGHIJKLMNOPQRSTUV",
    deviceID: deviceID
)
precondition(
    String(decoding: proof, as: UTF8.self)
        == #"{"audience":"cannabeats-host-proof","challenge":"ABCDEFGHIJKLMNOPQRSTUV","deviceId":"12345678-1234-4234-8234-123456789abc","origin":"https://play.cannabeats.social","version":1}"#
)

let bearers = try (0..<32).map { _ in try HostAuthorityProtocol.randomBearer() }
precondition(Set(bearers).count == bearers.count)
precondition(bearers.allSatisfy { value in
    value.count == 32
        && value.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil
})

let privateKey = P256.Signing.PrivateKey()
let signature = try privateKey.signature(for: proof)
precondition(privateKey.publicKey.isValidSignature(signature, for: proof))

actor LostResponseTransport {
    private var bodies: [Data] = []

    func send(_ request: URLRequest) throws -> (Data, URLResponse) {
        bodies.append(request.httpBody ?? Data())
        if bodies.count <= 2 { throw URLError(.networkConnectionLost) }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 201, httpVersion: "HTTP/1.1", headerFields: nil
        )!
        let body = Data(#"{"authorizedAt":1000,"code":"device_enrolled","deviceId":"12345678-1234-4234-8234-123456789abc","label":"Verifier Mac"}"#.utf8)
        return (body, response)
    }

    func retainedBodies() -> [Data] { bodies }
}

final class PendingEnrollmentMemory: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Data?

    func load() throws -> HostPendingEnrollment? {
        try lock.withLock {
            guard let value else { return nil }
            return try JSONDecoder().decode(HostPendingEnrollment.self, from: value)
        }
    }
    func save(_ intent: HostPendingEnrollment) throws {
        try lock.withLock { value = try JSONEncoder().encode(intent) }
    }
    func clear() { lock.withLock { value = nil } }
}

final class PendingProofMemory: @unchecked Sendable {
    private let lock = NSLock()
    private var value: HostPendingProof?

    func load() -> HostPendingProof? { lock.withLock { value } }
    func save(_ intent: HostPendingProof) { lock.withLock { value = intent } }
    func clear() { lock.withLock { value = nil } }
}

final class SessionMemory: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?

    func load() -> String? { lock.withLock { value } }
    func save(_ token: String) { lock.withLock { value = token } }
}

actor ProofLostResponseTransport {
    private var proofBodies: [Data] = []

    func send(_ request: URLRequest) throws -> (Data, URLResponse) {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 201, httpVersion: "HTTP/1.1", headerFields: nil
        )!
        if request.url!.path.hasSuffix("/issue") {
            return (Data(#"{"code":"challenge_issued","expiresAt":120000}"#.utf8), response)
        }
        proofBodies.append(request.httpBody ?? Data())
        if proofBodies.count <= 2 { throw URLError(.networkConnectionLost) }
        return (Data(#"{"code":"session_created","deviceId":"12345678-1234-4234-8234-123456789abc","expiresAt":2592000000}"#.utf8), response)
    }

    func retainedProofBodies() -> [Data] { proofBodies }
}

actor TerminalProofTransport {
    func send(_ request: URLRequest) -> (Data, URLResponse) {
        let isIssue = request.url!.path.hasSuffix("/issue")
        let response = HTTPURLResponse(
            url: request.url!, statusCode: isIssue ? 201 : 410,
            httpVersion: "HTTP/1.1", headerFields: nil
        )!
        let body = isIssue
            ? Data(#"{"code":"challenge_issued","expiresAt":120000}"#.utf8)
            : Data(#"{"ok":false,"code":"expired"}"#.utf8)
        return (body, response)
    }
}

actor EnrollmentFailureTransport {
    let code: String

    init(code: String) { self.code = code }

    func send(_ request: URLRequest) -> (Data, URLResponse) {
        (
            Data(#"{"ok":false,"code":"\#(code)"}"#.utf8),
            HTTPURLResponse(
                url: request.url!, statusCode: 409,
                httpVersion: "HTTP/1.1", headerFields: nil
            )!
        )
    }
}

let lostResponse = LostResponseTransport()
let pendingEnrollment = PendingEnrollmentMemory()
func makeClient() -> HostAuthorityClient { HostAuthorityClient(
    transport: { try await lostResponse.send($0) },
    identity: {
        HostDeviceProofIdentity(
            deviceID: deviceID, publicKeyDER: privateKey.publicKey.derRepresentation,
            signer: { try privateKey.signature(for: $0).derRepresentation }
        )
    },
    loadSession: { nil },
    saveSession: { _ in },
    loadPendingEnrollment: { try pendingEnrollment.load() },
    savePendingEnrollment: { try pendingEnrollment.save($0) },
    clearPendingEnrollment: { pendingEnrollment.clear() }
) }
let firstClient = makeClient()
let terminalHyphenEnrollmentCode = "XyxodeQysWzf4WPf7MB0wxz-"
do {
    _ = try await firstClient.enroll(
        code: terminalHyphenEnrollmentCode, label: "Verifier Mac"
    )
    preconditionFailure("the simulated response loss should escape both immediate retries")
} catch HostAuthorityClientError.transport {
    // The pending intent must survive construction of a replacement client.
}
let enrolled = try await makeClient().resumePendingEnrollment()!
let retried = await lostResponse.retainedBodies()
precondition(enrolled.deviceId == deviceID)
precondition(retried.count == 3)
precondition(retried.allSatisfy { $0 == retried[0] })
let wireBody = String(decoding: retried[0], as: UTF8.self)
precondition(wireBody.contains(#""deviceId":"12345678-1234-4234-8234-123456789abc""#))
let enrollmentWire = try JSONSerialization.jsonObject(with: retried[0]) as! [String: Any]
precondition(enrollmentWire["enrollmentCode"] as? String == terminalHyphenEnrollmentCode)

for code in ["expired", "already_used", "unauthorized", "request_conflict", "capacity_reached"] {
    let failureTransport = EnrollmentFailureTransport(code: code)
    let failurePending = PendingEnrollmentMemory()
    let failureClient = HostAuthorityClient(
        transport: { await failureTransport.send($0) },
        identity: {
            HostDeviceProofIdentity(
                deviceID: deviceID, publicKeyDER: privateKey.publicKey.derRepresentation,
                signer: { try privateKey.signature(for: $0).derRepresentation }
            )
        },
        loadSession: { nil }, saveSession: { _ in },
        loadPendingEnrollment: { try failurePending.load() },
        savePendingEnrollment: { try failurePending.save($0) },
        clearPendingEnrollment: { failurePending.clear() }
    )
    do {
        _ = try await failureClient.enroll(
            code: "ABCDEFGHIJKLMNOPQRSTUVWX", label: "Failure Mac"
        )
        preconditionFailure("enrollment failure should remain finite")
    } catch HostAuthorityClientError.server(let received) {
        precondition(received == code)
        let shouldClear = ["expired", "already_used", "unauthorized", "request_conflict"]
            .contains(code)
        let retained = try failurePending.load()
        precondition((retained == nil) == shouldClear)
    }
}

let proofTransport = ProofLostResponseTransport()
let pendingProof = PendingProofMemory()
let sessionMemory = SessionMemory()
func makeProofClient() -> HostAuthorityClient { HostAuthorityClient(
    transport: { try await proofTransport.send($0) },
    identity: {
        HostDeviceProofIdentity(
            deviceID: deviceID, publicKeyDER: privateKey.publicKey.derRepresentation,
            signer: { try privateKey.signature(for: $0).derRepresentation }
        )
    },
    loadSession: { sessionMemory.load() },
    saveSession: { sessionMemory.save($0) },
    loadPendingProof: { pendingProof.load() },
    savePendingProof: { pendingProof.save($0) },
    clearPendingProof: { pendingProof.clear() }
) }
do {
    _ = try await makeProofClient().establishApplicationSession()
    preconditionFailure("the simulated proof response loss should escape immediate retries")
} catch HostAuthorityClientError.transport {
    // The full signed proof intent must remain durable for a reconstructed client.
}
_ = try await makeProofClient().establishApplicationSession()
let proofRetries = await proofTransport.retainedProofBodies()
precondition(proofRetries.count == 3 && proofRetries.allSatisfy { $0 == proofRetries[0] })
let proofRequest = try JSONSerialization.jsonObject(with: proofRetries[0]) as! [String: String]
precondition(sessionMemory.load() == proofRequest["sessionToken"])
precondition(pendingProof.load() == nil)

let terminalTransport = TerminalProofTransport()
let terminalPending = PendingProofMemory()
let terminalClient = HostAuthorityClient(
    transport: { await terminalTransport.send($0) },
    identity: {
        HostDeviceProofIdentity(
            deviceID: deviceID, publicKeyDER: privateKey.publicKey.derRepresentation,
            signer: { try privateKey.signature(for: $0).derRepresentation }
        )
    },
    loadSession: { nil }, saveSession: { _ in },
    loadPendingProof: { terminalPending.load() },
    savePendingProof: { terminalPending.save($0) },
    clearPendingProof: { terminalPending.clear() }
)
do {
    _ = try await terminalClient.establishApplicationSession()
    preconditionFailure("expired proof should remain a finite terminal failure")
} catch HostAuthorityClientError.server("expired") {
    precondition(terminalPending.load() == nil)
}

actor HostExperienceTransport {
    private var requests: [URLRequest] = []

    func send(_ request: URLRequest) -> (Data, URLResponse) {
        requests.append(request)
        let path = request.url!.path
        let body: String
        let status: Int
        if path == "/api/host/readiness" {
            status = 200
            body = #"{"activeGame":{"gameId":"12345678-1234-4234-8234-123456789abc","lifecycle":"lobby","revision":2},"code":"host_readiness","hostContract":"1","relay":{"reason":"ready","state":"ready"}}"#
        } else if path == "/api/host/web-tickets/issue" {
            status = 201
            body = #"{"code":"ticket_issued","expiresAt":65000}"#
        } else if path.hasSuffix("/diagnostics/export") {
            status = 200
            body = #"{"audio":[],"code":"diagnostic_export","diagnostics":[],"game":{"lifecycle":"lobby","revision":2},"gameEvents":[{"occurredAt":1000,"outcome":"accepted","revision":0,"sequence":1,"type":"game_created"}],"generatedAt":9000,"playback":[]}"#
        } else {
            let requestBody = try! JSONSerialization.jsonObject(with: request.httpBody!)
                as! [String: Any]
            status = 201
            body = #"{"code":"diagnostic_recorded","record":{"code":"buffer_dropped","expiresAt":604809000,"gameId":"12345678-1234-4234-8234-123456789abc","kind":"audio","metricValue":4,"occurredAt":9000,"recordId":"\#(requestBody["recordId"] as! String)"}}"#
        }
        return (
            Data(body.utf8),
            HTTPURLResponse(
                url: request.url!, statusCode: status,
                httpVersion: "HTTP/1.1", headerFields: nil
            )!
        )
    }

    func retainedRequests() -> [URLRequest] { requests }
}

let experienceSession = SessionMemory()
experienceSession.save("ABCDEFGHIJKLMNOPQRSTUVWX")
let experienceTransport = HostExperienceTransport()
let experienceClient = HostAuthorityClient(
    transport: { await experienceTransport.send($0) },
    identity: {
        HostDeviceProofIdentity(
            deviceID: deviceID, publicKeyDER: privateKey.publicKey.derRepresentation,
            signer: { try privateKey.signature(for: $0).derRepresentation }
        )
    },
    loadSession: { experienceSession.load() }, saveSession: { experienceSession.save($0) }
)
let serverReadiness = try await experienceClient.hostReadiness()
precondition(serverReadiness.activeGame?.gameId == deviceID)
let invalidLifecycleClient = HostAuthorityClient(
    transport: { request in
        let body = Data(#"{"activeGame":{"gameId":"12345678-1234-4234-8234-123456789abc","lifecycle":"caller-authored","revision":2},"code":"host_readiness","hostContract":"1","relay":{"reason":"ready","state":"ready"}}"#.utf8)
        return (
            body,
            HTTPURLResponse(
                url: request.url!, statusCode: 200,
                httpVersion: "HTTP/1.1", headerFields: nil
            )!
        )
    },
    identity: {
        HostDeviceProofIdentity(
            deviceID: deviceID, publicKeyDER: privateKey.publicKey.derRepresentation,
            signer: { try privateKey.signature(for: $0).derRepresentation }
        )
    },
    loadSession: { experienceSession.load() }, saveSession: { experienceSession.save($0) }
)
do {
    _ = try await invalidLifecycleClient.hostReadiness()
    preconditionFailure("unknown active-game lifecycle must fail closed")
} catch HostAuthorityClientError.invalidResponse {}
_ = try await experienceClient.issueWebTicket()
let diagnosticID = UUID()
let diagnostic = try await experienceClient.recordDiagnostic(
    gameID: deviceID, recordID: diagnosticID, kind: .audio,
    code: .bufferDropped, metricValue: 4
)
precondition(diagnostic.recordId == diagnosticID && diagnostic.metricValue == 4)
let diagnosticExport = try await experienceClient.exportDiagnostics(gameID: deviceID)
precondition(diagnosticExport.gameEvents.map(\.type) == ["game_created"])
let experienceRequests = await experienceTransport.retainedRequests()
precondition(experienceRequests.count == 4)
precondition(experienceRequests.allSatisfy {
    $0.value(forHTTPHeaderField: HostAuthorityProtocol.hostContractHeader) == "1"
        && $0.value(forHTTPHeaderField: "Authorization")
            == "Bearer ABCDEFGHIJKLMNOPQRSTUVWX"
})

let readyProjection = HostReadinessBuilder.build(
    server: .success(serverReadiness), enrolled: true, spotifyState: .running,
    spotifyReadback: .success(SpotifyReadback(
        playerState: .paused, positionMilliseconds: 0, trackUri: nil
    )),
    audioCapture: .notDetermined
)
precondition(readyProjection.checks.map(\.name) == HostReadinessName.allCases)
precondition(Set(readyProjection.checks.map(\.name)).count == 7)
precondition(readyProjection.primaryAction.kind == .resumeGame)
precondition(readyProjection.primaryAction.enabled)
precondition(readyProjection.primaryAction.blockedBy == nil)
precondition(readyProjection.sharedAudioRuntimeEnabled)
precondition(readyProjection.checks.first(where: { $0.name == .audioCapture })?.recovery
    == .allowAudioCapture)
let noGameServer = try JSONDecoder().decode(
    HostServerReadiness.self,
    from: Data(#"{"activeGame":null,"code":"host_readiness","hostContract":"1","relay":{"reason":"ready","state":"ready"}}"#.utf8)
)
let createProjection = HostReadinessBuilder.build(
    server: .success(noGameServer), enrolled: true, spotifyState: .running,
    spotifyReadback: .success(SpotifyReadback(
        playerState: .paused, positionMilliseconds: 0, trackUri: nil
    )), audioCapture: .notDetermined
)
precondition(createProjection.primaryAction.kind == .createGame)
precondition(createProjection.primaryAction.enabled)
let timeoutProjection = HostReadinessBuilder.build(
    server: .success(noGameServer), enrolled: true, spotifyState: .running,
    spotifyReadback: .failure(.commandTimeout), audioCapture: .ready
)
precondition(timeoutProjection.primaryAction.enabled == false)
precondition(timeoutProjection.primaryAction.blockedBy == .retrySpotify)
precondition(timeoutProjection.sharedAudioRuntimeEnabled == false)
let blockedActiveServer = try JSONDecoder().decode(
    HostServerReadiness.self,
    from: Data(#"{"activeGame":{"gameId":"12345678-1234-4234-8234-123456789abc","lifecycle":"active","revision":2},"code":"host_readiness","hostContract":"1","relay":{"reason":"relay_unavailable","state":"blocked"}}"#.utf8)
)
let blockedRuntimeProjection = HostReadinessBuilder.build(
    server: .success(blockedActiveServer), enrolled: true, spotifyState: .running,
    spotifyReadback: .success(SpotifyReadback(
        playerState: .paused, positionMilliseconds: 0, trackUri: nil
    )), audioCapture: .ready
)
precondition(blockedRuntimeProjection.primaryAction.enabled == false)
precondition(blockedRuntimeProjection.sharedAudioRuntimeEnabled == false)
precondition(HostGameRuntimeReconciler.directive(
    serverReadinessConfirmed: false, readiness: blockedRuntimeProjection
) == .preserve)
precondition(HostGameRuntimeReconciler.lifecycleDecisionConfirmed(
    by: Result<HostServerReadiness, HostAuthorityClientError>.failure(.transport)
) == false)
precondition(HostGameRuntimeReconciler.lifecycleDecisionConfirmed(
    by: Result<HostServerReadiness, HostAuthorityClientError>.failure(.noApplicationSession)
) == true)
precondition(HostGameRuntimeReconciler.directive(
    serverReadinessConfirmed: true, readiness: blockedRuntimeProjection
) == .stop)
precondition(HostGameRuntimeReconciler.directive(
    serverReadinessConfirmed: true, readiness: readyProjection
) == .start(serverReadiness.activeGame!.gameId))
let upgradeProjection = HostReadinessBuilder.build(
    server: .failure(.server("upgrade_required")), enrolled: true,
    spotifyState: .running, spotifyReadback: nil, audioCapture: .ready
)
precondition(upgradeProjection.primaryAction.enabled == false)
precondition(upgradeProjection.primaryAction.blockedBy == .updateHost)
precondition(upgradeProjection.checks.filter { $0.state != .ready }.allSatisfy {
    !($0.recovery?.message.isEmpty ?? true)
})

var playbackStarts = 0
var playbackStops = 0
let audioGate = PlaybackAudioGate(
    start: { playbackStarts += 1 }, stop: { playbackStops += 1 }
)
audioGate.setSharedAudioReady(false)
audioGate.setSharedAudioReady(true)
audioGate.setSharedAudioReady(true)
audioGate.setSharedAudioReady(false)
audioGate.setSharedAudioReady(false)
audioGate.setSharedAudioReady(true)
audioGate.close()
audioGate.close()
audioGate.setSharedAudioReady(true)
precondition(playbackStarts == 2 && playbackStops == 2)

print("host_authority_and_experience_valid (23 checks)")
