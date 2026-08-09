import AppKit
import Combine
import Foundation

private struct APIErrorBody: Decodable {
    let error: String
}

private struct PairStartRequest: Encodable {
    let displayName: String
    let publicKeyDer: String
}

private struct PairStartResponse: Decodable {
    let code: String
    let pairingSecret: String
    let expiresAt: Date
    let verificationUrl: URL
}

private struct PairStatusRequest: Encodable {
    let pairingSecret: String
}

private struct PairedAgent: Decodable {
    let id: String
    let displayName: String
    let userId: String
    let userDisplayName: String
}

private struct PairStatusResponse: Decodable {
    let status: String
    let agent: PairedAgent?
}

private struct AgentIDRequest: Encodable {
    let agentId: String
}

private struct AgentChallenge: Decodable {
    let challengeToken: String
    let challenge: String
    let expiresAt: Date
}

private struct AgentProofRequest: Encodable {
    let agentId: String
    let challengeToken: String
    let signature: String
}

private struct AgentProofResponse: Decodable {
    struct User: Decodable {
        let id: String
        let displayName: String
        let role: String
    }

    let ok: Bool
    let user: User
    let message: String
}

private struct EmptyRequest: Encodable {}

private struct HostAPIClient {
    let origin: URL

    init(originText: String) throws {
        guard var components = URLComponents(string: originText.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = components.scheme?.lowercased(),
              ["https", "http"].contains(scheme),
              components.host != nil else {
            throw URLError(.badURL)
        }
        components.scheme = scheme
        components.path = ""
        components.query = nil
        components.fragment = nil
        guard let normalized = components.url else { throw URLError(.badURL) }
        origin = normalized
    }

    var originString: String {
        var value = origin.absoluteString
        if value.hasSuffix("/") { value.removeLast() }
        return value
    }

    func post<Request: Encodable, Response: Decodable>(
        _ path: String,
        body: Request,
        response: Response.Type = Response.self
    ) async throws -> Response {
        guard let url = URL(string: originString + path) else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(originString, forHTTPHeaderField: "Origin")
        request.timeoutInterval = 20

        let (data, rawResponse) = try await URLSession.shared.data(for: request)
        guard let http = rawResponse as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder.api.decode(APIErrorBody.self, from: data).error)
                ?? "CannaBeats returned HTTP \(http.statusCode)."
            throw HostAgentError.server(message)
        }
        return try JSONDecoder.api.decode(Response.self, from: data)
    }
}

private extension JSONDecoder {
    static var api: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

enum HostAgentError: LocalizedError {
    case server(String)
    case missingKey
    case invalidChallenge

    var errorDescription: String? {
        switch self {
        case .server(let message): message
        case .missingKey: "This Mac no longer has the signing key used during pairing. Reset and pair it again."
        case .invalidChallenge: "The server returned an invalid device challenge."
        }
    }
}

@MainActor
final class HostAgentModel: ObservableObject {
    private enum DefaultsKey {
        static let serverOrigin = "host-poc.server-origin"
        static let agentID = "host-poc.agent-id"
        static let pairedUser = "host-poc.paired-user"
    }

    @Published var serverOrigin: String
    @Published var deviceName: String
    @Published private(set) var pairingCode = ""
    @Published private(set) var verificationURL: URL?
    @Published private(set) var agentID: String?
    @Published private(set) var pairedUser = ""
    @Published private(set) var keyProtection = "No device key created"
    @Published private(set) var status = "Ready to pair this Mac."
    @Published private(set) var errorMessage = ""
    @Published private(set) var isBusy = false

    private var signingKey: DeviceSigningKey?
    private var pairingSecret: String?
    private var pairingExpiresAt: Date?
    private var pollingTask: Task<Void, Never>?

    init() {
        let defaults = UserDefaults.standard
        serverOrigin = defaults.string(forKey: DefaultsKey.serverOrigin)
            ?? "https://poc.cannabeats.social"
        deviceName = Host.current().localizedName.map { "CannaBeats Host on \($0)" }
            ?? "CannaBeats Host on this Mac"
        agentID = defaults.string(forKey: DefaultsKey.agentID)
        pairedUser = defaults.string(forKey: DefaultsKey.pairedUser) ?? ""

        if agentID != nil {
            do {
                signingKey = try DeviceSigningKey.load()
                guard signingKey != nil else { throw HostAgentError.missingKey }
                keyProtection = signingKey?.protectionDescription ?? keyProtection
                status = "This Mac has a saved host authorization. Prove it to verify the connection."
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    var isPaired: Bool { agentID != nil }
    var canOpenAuthorization: Bool { verificationURL != nil }

    func startPairing() async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = ""
        status = "Creating this Mac’s signing identity…"
        defer { isBusy = false }

        do {
            let client = try HostAPIClient(originText: serverOrigin)
            let key = try DeviceSigningKey.loadOrCreate()
            signingKey = key
            keyProtection = key.protectionDescription
            let result: PairStartResponse = try await client.post(
                "/api/host-agents/pair/start",
                body: PairStartRequest(
                    displayName: deviceName.trimmingCharacters(in: .whitespacesAndNewlines),
                    publicKeyDer: key.publicKeyDER.base64EncodedString()
                )
            )
            UserDefaults.standard.set(client.originString, forKey: DefaultsKey.serverOrigin)
            serverOrigin = client.originString
            pairingCode = result.code
            pairingSecret = result.pairingSecret
            pairingExpiresAt = result.expiresAt
            verificationURL = result.verificationUrl
            status = "Approve code \(result.code) with your CannaBeats passkey."
            NSWorkspace.shared.open(result.verificationUrl)
            beginPolling()
        } catch {
            errorMessage = error.localizedDescription
            status = "Pairing did not start."
        }
    }

    func openAuthorizationPage() {
        guard let verificationURL else { return }
        NSWorkspace.shared.open(verificationURL)
    }

    func checkPairingOnce() async {
        guard let pairingSecret else { return }
        do {
            let client = try HostAPIClient(originText: serverOrigin)
            let result: PairStatusResponse = try await client.post(
                "/api/host-agents/pair/status",
                body: PairStatusRequest(pairingSecret: pairingSecret)
            )
            guard result.status == "authorized", let agent = result.agent else {
                status = "Waiting for passkey approval of \(pairingCode)…"
                return
            }
            agentID = agent.id
            pairedUser = agent.userDisplayName
            UserDefaults.standard.set(agent.id, forKey: DefaultsKey.agentID)
            UserDefaults.standard.set(agent.userDisplayName, forKey: DefaultsKey.pairedUser)
            self.pairingSecret = nil
            pairingExpiresAt = nil
            verificationURL = nil
            pairingCode = ""
            pollingTask?.cancel()
            status = "Authorized for \(agent.userDisplayName). Proving the device key…"
            await proveAuthorization()
        } catch {
            errorMessage = error.localizedDescription
            status = "Pairing check failed."
        }
    }

    func proveAuthorization() async {
        guard !isBusy, let agentID else { return }
        isBusy = true
        errorMessage = ""
        status = "Signing a one-time server challenge…"
        defer { isBusy = false }

        do {
            let client = try HostAPIClient(originText: serverOrigin)
            let key: DeviceSigningKey
            if let signingKey {
                key = signingKey
            } else if let stored = try DeviceSigningKey.load() {
                key = stored
            } else {
                throw HostAgentError.missingKey
            }
            signingKey = key
            keyProtection = key.protectionDescription
            let challenge: AgentChallenge = try await client.post(
                "/api/host-agents/challenge",
                body: AgentIDRequest(agentId: agentID)
            )
            guard let challengeData = challenge.challenge.data(using: .utf8) else {
                throw HostAgentError.invalidChallenge
            }
            let signature = try key.signature(for: challengeData).base64EncodedString()
            let proof: AgentProofResponse = try await client.post(
                "/api/host-agents/verify",
                body: AgentProofRequest(
                    agentId: agentID,
                    challengeToken: challenge.challengeToken,
                    signature: signature
                )
            )
            pairedUser = proof.user.displayName
            UserDefaults.standard.set(proof.user.displayName, forKey: DefaultsKey.pairedUser)
            status = proof.message
        } catch {
            errorMessage = error.localizedDescription
            status = "Device proof failed."
        }
    }

    func resetLocalAuthorization() {
        pollingTask?.cancel()
        do {
            try DeviceSigningKey.delete()
        } catch {
            errorMessage = error.localizedDescription
            return
        }
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: DefaultsKey.agentID)
        defaults.removeObject(forKey: DefaultsKey.pairedUser)
        signingKey = nil
        pairingSecret = nil
        pairingExpiresAt = nil
        pairingCode = ""
        verificationURL = nil
        agentID = nil
        pairedUser = ""
        keyProtection = "No device key created"
        errorMessage = ""
        status = "Local authorization removed. Revoke the old application from your CannaBeats account if needed."
    }

    private func beginPolling() {
        pollingTask?.cancel()
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if let expires = self.pairingExpiresAt, expires <= Date() {
                    self.status = "Pairing code expired. Start again."
                    return
                }
                try? await Task.sleep(for: .seconds(2))
                if Task.isCancelled { return }
                await self.checkPairingOnce()
                if self.agentID != nil { return }
            }
        }
    }
}
