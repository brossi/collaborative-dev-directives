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
    private var value: HostPendingEnrollment?

    func load() -> HostPendingEnrollment? { lock.withLock { value } }
    func save(_ intent: HostPendingEnrollment) { lock.withLock { value = intent } }
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
    loadPendingEnrollment: { pendingEnrollment.load() },
    savePendingEnrollment: { pendingEnrollment.save($0) },
    clearPendingEnrollment: { pendingEnrollment.clear() }
) }
let firstClient = makeClient()
do {
    _ = try await firstClient.enroll(
        code: "ABCDEFGHIJKLMNOPQRSTUV", label: "Verifier Mac"
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

print("host_authority_protocol_valid (6 checks)")
