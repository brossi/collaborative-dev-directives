import Foundation

public enum HostAuthorityClientError: Error, Equatable {
    case noApplicationSession
    case invalidResponse
    case pendingEnrollmentExists
    case pendingProofExists
    case server(String)
    case transport
}

public struct HostDevice: Codable, Equatable, Sendable {
    public let deviceId: UUID
    public let label: String
    public let authorizedAt: Int64
    public let lastProvedAt: Int64?
    public let revokedAt: Int64?
}

public struct HostEnrollment: Codable, Equatable, Sendable {
    public let code: String
    public let expiresAt: Int64
}

public struct HostWebTicket: Equatable, Sendable {
    public let value: String
    public let expiresAt: Int64
}

public struct HostDeviceProofIdentity: Sendable {
    public let deviceID: UUID
    public let publicKeyDER: Data
    private let signer: @Sendable (Data) throws -> Data

    public init(
        deviceID: UUID, publicKeyDER: Data,
        signer: @escaping @Sendable (Data) throws -> Data
    ) {
        self.deviceID = deviceID
        self.publicKeyDER = publicKeyDER
        self.signer = signer
    }

    public func signature(for data: Data) throws -> Data { try signer(data) }
}

public actor HostAuthorityClient {
    private let origin: URL
    private let transport: @Sendable (URLRequest) async throws -> (Data, URLResponse)
    private let identity: @Sendable () throws -> HostDeviceProofIdentity
    private let loadSession: @Sendable () throws -> String?
    private let saveSession: @Sendable (String) throws -> Void
    private let loadPendingEnrollment: @Sendable () throws -> HostPendingEnrollment?
    private let savePendingEnrollment: @Sendable (HostPendingEnrollment) throws -> Void
    private let clearPendingEnrollment: @Sendable () throws -> Void
    private let loadPendingProof: @Sendable () throws -> HostPendingProof?
    private let savePendingProof: @Sendable (HostPendingProof) throws -> Void
    private let clearPendingProof: @Sendable () throws -> Void

    public init(
        origin: URL = HostAuthorityProtocol.productionOrigin,
        transport: @escaping @Sendable (URLRequest) async throws -> (Data, URLResponse) = {
            try await URLSession.shared.data(for: $0)
        },
        identity: @escaping @Sendable () throws -> HostDeviceProofIdentity = {
            let deviceID = try HostCredentials.deviceID()
            let key = try DeviceSigningKey.loadOrCreate()
            return HostDeviceProofIdentity(
                deviceID: deviceID, publicKeyDER: key.publicKeyDER,
                signer: {
                    guard let retained = try DeviceSigningKey.load() else {
                        throw DeviceKeyError.invalidStoredKey
                    }
                    return try retained.signature(for: $0)
                }
            )
        },
        loadSession: @escaping @Sendable () throws -> String? = {
            try HostCredentials.applicationSession()
        },
        saveSession: @escaping @Sendable (String) throws -> Void = {
            try HostCredentials.saveApplicationSession($0)
        },
        loadPendingEnrollment: @escaping @Sendable () throws -> HostPendingEnrollment? = {
            try HostCredentials.pendingEnrollment()
        },
        savePendingEnrollment: @escaping @Sendable (HostPendingEnrollment) throws -> Void = {
            try HostCredentials.savePendingEnrollment($0)
        },
        clearPendingEnrollment: @escaping @Sendable () throws -> Void = {
            try HostCredentials.clearPendingEnrollment()
        },
        loadPendingProof: @escaping @Sendable () throws -> HostPendingProof? = {
            try HostCredentials.pendingProof()
        },
        savePendingProof: @escaping @Sendable (HostPendingProof) throws -> Void = {
            try HostCredentials.savePendingProof($0)
        },
        clearPendingProof: @escaping @Sendable () throws -> Void = {
            try HostCredentials.clearPendingProof()
        }
    ) {
        self.origin = origin
        self.transport = transport
        self.identity = identity
        self.loadSession = loadSession
        self.saveSession = saveSession
        self.loadPendingEnrollment = loadPendingEnrollment
        self.savePendingEnrollment = savePendingEnrollment
        self.clearPendingEnrollment = clearPendingEnrollment
        self.loadPendingProof = loadPendingProof
        self.savePendingProof = savePendingProof
        self.clearPendingProof = clearPendingProof
    }

    public func enroll(code: String, label: String) async throws -> HostDevice {
        let identity = try identity()
        let proposed = HostPendingEnrollment(
            deviceId: wire(identity.deviceID),
            enrollmentCode: code,
            label: label,
            publicKey: identity.publicKeyDER.base64EncodedString(),
            requestId: wire(UUID())
        )
        let intent: HostPendingEnrollment
        if let retained = try loadPendingEnrollment() {
            guard retained.deviceId == proposed.deviceId
                    && retained.enrollmentCode == proposed.enrollmentCode
                    && retained.label == proposed.label
                    && retained.publicKey == proposed.publicKey else {
                throw HostAuthorityClientError.pendingEnrollmentExists
            }
            intent = retained
        } else {
            intent = proposed
            try savePendingEnrollment(intent)
        }
        let result: EnrollResponse = try await mutation(
            "/api/host/enrollments/redeem", EnrollRequest(intent)
        )
        try clearPendingEnrollment()
        return HostDevice(
            deviceId: result.deviceId, label: result.label, authorizedAt: result.authorizedAt,
            lastProvedAt: nil, revokedAt: nil
        )
    }

    public func resumePendingEnrollment() async throws -> HostDevice? {
        guard let intent = try loadPendingEnrollment() else { return nil }
        let identity = try identity()
        guard intent.deviceId == wire(identity.deviceID)
                && intent.publicKey == identity.publicKeyDER.base64EncodedString() else {
            throw HostAuthorityClientError.pendingEnrollmentExists
        }
        let result: EnrollResponse = try await mutation(
            "/api/host/enrollments/redeem", EnrollRequest(intent)
        )
        try clearPendingEnrollment()
        return HostDevice(
            deviceId: result.deviceId, label: result.label, authorizedAt: result.authorizedAt,
            lastProvedAt: nil, revokedAt: nil
        )
    }

    public func establishApplicationSession() async throws -> Int64 {
        let identity = try identity()
        let deviceID = identity.deviceID
        let intent: HostPendingProof
        if let retained = try loadPendingProof() {
            guard retained.deviceId == wire(deviceID) else {
                throw HostAuthorityClientError.pendingProofExists
            }
            intent = retained
        } else {
            let challenge = try HostAuthorityProtocol.randomBearer()
            let proof = try HostAuthorityProtocol.proofData(
                challenge: challenge, deviceID: deviceID, origin: origin
            )
            intent = HostPendingProof(
                challenge: challenge, challengeRequestId: wire(UUID()),
                deviceId: wire(deviceID), proofRequestId: wire(UUID()),
                sessionToken: try HostAuthorityProtocol.randomBearer(),
                signature: try identity.signature(for: proof).base64EncodedString()
            )
            try savePendingProof(intent)
        }
        let issued: ExpiringResponse = try await mutation(
            "/api/host/challenges/issue",
            ChallengeRequest(
                challenge: intent.challenge, deviceId: intent.deviceId,
                requestId: intent.challengeRequestId
            )
        )
        guard issued.code == "challenge_issued" else { throw HostAuthorityClientError.invalidResponse }
        let session: SessionResponse
        do {
            session = try await mutation(
                "/api/host/challenges/prove",
                ProofRequest(
                    challenge: intent.challenge, deviceId: intent.deviceId,
                    requestId: intent.proofRequestId, sessionToken: intent.sessionToken,
                    signature: intent.signature
                )
            )
        } catch HostAuthorityClientError.server(let code)
            where ["expired", "already_used", "proof_rejected", "request_conflict"].contains(code) {
            try clearPendingProof()
            throw HostAuthorityClientError.server(code)
        }
        guard session.code == "session_created", session.deviceId == deviceID else {
            throw HostAuthorityClientError.invalidResponse
        }
        try saveSession(intent.sessionToken)
        try clearPendingProof()
        return session.expiresAt
    }

    public func issueEnrollment() async throws -> HostEnrollment {
        let code = try HostAuthorityProtocol.randomBearer()
        let result: ExpiringResponse = try await mutation(
            "/api/host/enrollments/issue",
            EnrollmentIssueRequest(enrollmentCode: code, requestId: wire(UUID())),
            bearer: try requiredSession()
        )
        guard result.code == "enrollment_issued" else {
            throw HostAuthorityClientError.invalidResponse
        }
        return HostEnrollment(code: code, expiresAt: result.expiresAt)
    }

    public func issueWebTicket() async throws -> HostWebTicket {
        let ticket = try HostAuthorityProtocol.randomBearer()
        let result: ExpiringResponse = try await mutation(
            "/api/host/web-tickets/issue",
            TicketRequest(requestId: wire(UUID()), ticket: ticket),
            bearer: try requiredSession()
        )
        guard result.code == "ticket_issued" else { throw HostAuthorityClientError.invalidResponse }
        return HostWebTicket(value: ticket, expiresAt: result.expiresAt)
    }

    public func devices() async throws -> [HostDevice] {
        var request = URLRequest(url: try endpoint("/api/host/devices"))
        request.setValue("Bearer \(try requiredSession())", forHTTPHeaderField: "Authorization")
        let response: DeviceListResponse = try await send(request)
        return response.devices
    }

    public func revoke(deviceID: UUID) async throws {
        let response: CodeResponse = try await mutation(
            "/api/host/devices/\(deviceID.uuidString.lowercased())/revoke",
            RequestIdentity(requestId: wire(UUID())), bearer: try requiredSession()
        )
        guard response.code == "device_revoked" else {
            throw HostAuthorityClientError.invalidResponse
        }
    }

    private func requiredSession() throws -> String {
        guard let session = try loadSession() else {
            throw HostAuthorityClientError.noApplicationSession
        }
        return session
    }

    private func mutation<Request: Encodable, Response: Decodable>(
        _ path: String, _ body: Request, bearer: String? = nil
    ) async throws -> Response {
        var request = URLRequest(url: try endpoint(path))
        request.httpMethod = "POST"
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        request.httpBody = try encoder.encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        // Both attempts contain identical caller-generated IDs and secrets, so a lost response
        // cannot create a second effect.
        do { return try await send(request) }
        catch HostAuthorityClientError.transport { return try await send(request) }
    }

    private func send<Response: Decodable>(_ request: URLRequest) async throws -> Response {
        let data: Data
        let rawResponse: URLResponse
        do { (data, rawResponse) = try await transport(request) }
        catch { throw HostAuthorityClientError.transport }
        guard let response = rawResponse as? HTTPURLResponse else {
            throw HostAuthorityClientError.invalidResponse
        }
        if !(200..<300).contains(response.statusCode) {
            if let failure = try? JSONDecoder().decode(FailureResponse.self, from: data) {
                throw HostAuthorityClientError.server(failure.code)
            }
            throw HostAuthorityClientError.invalidResponse
        }
        guard let decoded = try? JSONDecoder().decode(Response.self, from: data) else {
            throw HostAuthorityClientError.invalidResponse
        }
        return decoded
    }

    private func endpoint(_ path: String) throws -> URL {
        guard origin.scheme == "https", origin.host != nil,
              let result = URL(string: path, relativeTo: origin)?.absoluteURL else {
            throw HostAuthorityProtocolError.invalidOrigin
        }
        return result
    }
}

private func wire(_ identifier: UUID) -> String { identifier.uuidString.lowercased() }

private struct RequestIdentity: Codable { let requestId: String }
private struct EnrollmentIssueRequest: Codable { let enrollmentCode: String; let requestId: String }
private struct EnrollRequest: Codable {
    let deviceId: String; let enrollmentCode: String; let label: String
    let publicKey: String; let requestId: String

    init(_ intent: HostPendingEnrollment) {
        deviceId = intent.deviceId
        enrollmentCode = intent.enrollmentCode
        label = intent.label
        publicKey = intent.publicKey
        requestId = intent.requestId
    }
}
private struct ChallengeRequest: Codable {
    let challenge: String; let deviceId: String; let requestId: String
}
private struct ProofRequest: Codable {
    let challenge: String; let deviceId: String; let requestId: String
    let sessionToken: String; let signature: String
}
private struct TicketRequest: Codable { let requestId: String; let ticket: String }
private struct CodeResponse: Codable { let code: String }
private struct ExpiringResponse: Codable { let code: String; let expiresAt: Int64 }
private struct EnrollResponse: Codable {
    let authorizedAt: Int64; let code: String; let deviceId: UUID; let label: String
}
private struct SessionResponse: Codable { let code: String; let deviceId: UUID; let expiresAt: Int64 }
private struct DeviceListResponse: Codable { let devices: [HostDevice] }
private struct FailureResponse: Codable { let code: String }
