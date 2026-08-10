import AppKit
import AudioTapBridge
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

private struct HostGameSessionRequest: Encodable {
    let agentId: String
    let challengeToken: String
    let signature: String
    let code: String?
}

private struct HostGameSession: Decodable {
    let code: String
}

private struct HostGameSessionResponse: Decodable {
    let session: HostGameSession
    let created: Bool
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

private struct RelayGrantResponse: Decodable {
    let relay: RelayGrant
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
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fractional.date(from: value) {
                return date
            }
            let wholeSeconds = ISO8601DateFormatter()
            wholeSeconds.formatOptions = [.withInternetDateTime]
            if let date = wholeSeconds.date(from: value) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "The server returned an unsupported ISO-8601 date: \(value)"
            )
        }
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
    @Published private(set) var audioProcesses: [CBAudioProcessInfo] = []
    @Published var selectedAudioProcessID: UInt32 = 0
    @Published var existingGameCode = ""
    @Published private(set) var activeGameCode = ""
    @Published private(set) var gameSessionStatus = "Create a new game or enter a code for one you already host."
    @Published private(set) var isRelaying = false
    @Published private(set) var isAwaitingAudioProcess = false
    @Published private(set) var audioStatus = "Local Mac audio fallback is not active."
    @Published private(set) var audioMetrics = "No audio captured yet."

    private var signingKey: DeviceSigningKey?
    private var pairingSecret: String?
    private var pairingExpiresAt: Date?
    private var pollingTask: Task<Void, Never>?
    private var relaySession: RelayAudioSession?
    private var metricsTimer: Timer?
    private var processDiscoveryTimer: Timer?
    private var baselineAudioProcessIDs: Set<UInt32> = []
    private var preparedRelayGrant: RelayGrant?

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
    var canUseExistingGameCode: Bool { normalizeGameCode(existingGameCode).count == 6 }
    var formattedActiveGameCode: String {
        activeGameCode
    }
    var selectedAudioProcess: CBAudioProcessInfo? {
        audioProcesses.first { $0.objectID == selectedAudioProcessID }
    }

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

    func refreshAudioProcesses() {
        let previous = selectedAudioProcessID
        audioProcesses = CBAudioTap.audioOutputProcesses()
        if audioProcesses.contains(where: { $0.objectID == previous }) {
            return
        }
        let preferred = audioProcesses.first { process in
            let identity = "\(process.displayName) \(process.bundleIdentifier)".lowercased()
            return identity.contains("spotify") || identity.contains("cannabeats")
        }
        selectedAudioProcessID = preferred?.objectID ?? audioProcesses.first?.objectID ?? 0
        audioStatus = audioProcesses.isEmpty
            ? "No process is currently producing audio. Start Spotify playback and refresh."
            : "Choose the process producing the Spotify audio."
    }

    func createGameAndOpenCannaBeats() async {
        await prepareGameAndOpenCannaBeats(existingCode: nil)
    }

    func useExistingGameAndOpenCannaBeats() async {
        let code = normalizeGameCode(existingGameCode)
        guard code.count == 6 else {
            errorMessage = "Enter a valid six-character lobby code."
            gameSessionStatus = "The existing lobby code is invalid."
            return
        }
        existingGameCode = formattedGameCode(code)
        await prepareGameAndOpenCannaBeats(existingCode: code)
    }

    private func prepareGameAndOpenCannaBeats(existingCode: String?) async {
        guard !isBusy, !isRelaying, !isAwaitingAudioProcess, let agentID else { return }
        isBusy = true
        errorMessage = ""
        gameSessionStatus = existingCode == nil
            ? "Creating a new game session…"
            : "Validating the existing game session…"
        audioStatus = "The game will use the managed Linux Spotify source by default."
        defer { isBusy = false }

        do {
            let game = try await prepareGameSession(agentID: agentID, existingCode: existingCode)
            activeGameCode = game.session.code
            self.existingGameCode = formattedGameCode(game.session.code)
            gameSessionStatus = game.created
                ? "Created game \(formattedActiveGameCode)."
                : "Using game \(formattedActiveGameCode)."
            audioStatus = "CannaBeats is opening with the managed Linux Spotify source selected."
            openCannaBeats(gameCode: game.session.code)
        } catch {
            preparedRelayGrant = nil
            errorMessage = error.localizedDescription
            audioStatus = "The game could not be opened."
        }
    }

    func openCannaBeats() {
        guard !activeGameCode.isEmpty else {
            errorMessage = "Create or select a game before opening CannaBeats."
            return
        }
        openCannaBeats(gameCode: activeGameCode)
    }

    private func openCannaBeats(gameCode: String) {
        guard let origin = try? HostAPIClient(originText: serverOrigin).origin,
              var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return }
        components.path = "/game"
        components.queryItems = [URLQueryItem(name: "session", value: gameCode)]
        guard let launchURL = components.url else { return }
        if let applicationURL = installedPWA(for: origin) {
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            NSWorkspace.shared.open(
                [launchURL],
                withApplicationAt: applicationURL,
                configuration: configuration
            ) { [weak self] _, error in
                guard let error else { return }
                Task { @MainActor in
                    self?.errorMessage = "The installed CannaBeats app did not open: \(error.localizedDescription)"
                    NSWorkspace.shared.open(launchURL)
                }
            }
        } else {
            NSWorkspace.shared.open(launchURL)
        }
    }

    func cancelAudioPreparation() {
        processDiscoveryTimer?.invalidate()
        processDiscoveryTimer = nil
        preparedRelayGrant = nil
        baselineAudioProcessIDs.removeAll()
        isAwaitingAudioProcess = false
        audioStatus = "Shared audio preparation cancelled."
    }

    func startSharedAudio() async {
        guard !isBusy, !isRelaying, let agentID, selectedAudioProcess != nil else { return }
        isBusy = true
        errorMessage = ""
        audioStatus = preparedRelayGrant == nil
            ? "Requesting an authenticated relay grant…"
            : "Attaching to the selected audio process…"
        defer { isBusy = false }

        do {
            let grant: RelayGrant
            if let preparedRelayGrant {
                grant = preparedRelayGrant
            } else {
                grant = try await fetchRelayGrant(agentID: agentID)
            }
            let session = RelayAudioSession()
            try session.start(
                processObjectID: selectedAudioProcessID,
                grant: grant,
                stateHandler: { [weak self] message in
                    Task { @MainActor in self?.audioStatus = message }
                }
            )
            relaySession = session
            preparedRelayGrant = nil
            processDiscoveryTimer?.invalidate()
            processDiscoveryTimer = nil
            isAwaitingAudioProcess = false
            isRelaying = true
            audioStatus = "Process tap started. Waiting for relayed playback…"
            startMetricsTimer()
        } catch {
            relaySession?.stop()
            relaySession = nil
            preparedRelayGrant = nil
            baselineAudioProcessIDs.removeAll()
            isAwaitingAudioProcess = false
            isRelaying = false
            errorMessage = error.localizedDescription
            audioStatus = "Shared audio did not start."
        }
    }

    func stopSharedAudio() {
        metricsTimer?.invalidate()
        metricsTimer = nil
        processDiscoveryTimer?.invalidate()
        processDiscoveryTimer = nil
        relaySession?.stop()
        relaySession = nil
        preparedRelayGrant = nil
        baselineAudioProcessIDs.removeAll()
        isAwaitingAudioProcess = false
        isRelaying = false
        audioStatus = "Shared audio stopped; direct playback is restored."
    }

    func resetLocalAuthorization() {
        pollingTask?.cancel()
        stopSharedAudio()
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
        existingGameCode = ""
        activeGameCode = ""
        gameSessionStatus = "Create a new game or enter a code for one you already host."
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

    private func prepareGameSession(
        agentID: String,
        existingCode: String?
    ) async throws -> HostGameSessionResponse {
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
        let challenge: AgentChallenge = try await client.post(
            "/api/host-agents/challenge",
            body: AgentIDRequest(agentId: agentID)
        )
        guard let challengeData = challenge.challenge.data(using: .utf8) else {
            throw HostAgentError.invalidChallenge
        }
        let signature = try key.signature(for: challengeData).base64EncodedString()
        return try await client.post(
            "/api/host-agents/game-sessions/prepare",
            body: HostGameSessionRequest(
                agentId: agentID,
                challengeToken: challenge.challengeToken,
                signature: signature,
                code: existingCode
            )
        )
    }

    private func fetchRelayGrant(agentID: String) async throws -> RelayGrant {
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
        let challenge: AgentChallenge = try await client.post(
            "/api/host-agents/challenge",
            body: AgentIDRequest(agentId: agentID)
        )
        guard let challengeData = challenge.challenge.data(using: .utf8) else {
            throw HostAgentError.invalidChallenge
        }
        let signature = try key.signature(for: challengeData).base64EncodedString()
        let response: RelayGrantResponse = try await client.post(
            "/api/host-agents/relay-grant",
            body: AgentProofRequest(
                agentId: agentID,
                challengeToken: challenge.challengeToken,
                signature: signature
            )
        )
        return response.relay
    }

    private func normalizeGameCode(_ value: String) -> String {
        let allowed = Set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        let compact = value.uppercased().filter { $0 != "-" && !$0.isWhitespace }
        guard compact.allSatisfy({ allowed.contains($0) }) else { return "" }
        return compact
    }

    private func formattedGameCode(_ code: String) -> String {
        code
    }

    private func startMetricsTimer() {
        metricsTimer?.invalidate()
        metricsTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let session = self.relaySession else { return }
                let seconds = session.sampleRate > 0
                    ? Double(session.capturedFrames) / session.sampleRate
                    : 0
                let peak = session.peakLevel > 0
                    ? 20 * log10(Double(session.peakLevel))
                    : -.infinity
                let peakText = peak.isFinite ? String(format: "%.1f dBFS", peak) : "silence"
                self.audioMetrics = String(
                    format: "Captured %.1f s • Peak %@ • Dropped upload packets %llu",
                    seconds, peakText, session.droppedUploadPackets
                )
            }
        }
    }

    private func startAudioProcessDiscovery() {
        processDiscoveryTimer?.invalidate()
        processDiscoveryTimer = Timer.scheduledTimer(
            withTimeInterval: 0.5,
            repeats: true
        ) { [weak self] _ in
            Task { @MainActor in self?.discoverNewAudioProcess() }
        }
    }

    private func discoverNewAudioProcess() {
        guard isAwaitingAudioProcess, !isBusy, !isRelaying else { return }
        let active = CBAudioTap.audioOutputProcesses()
        audioProcesses = active
        let candidates = active.filter {
            !baselineAudioProcessIDs.contains($0.objectID) &&
                $0.processIdentifier != ProcessInfo.processInfo.processIdentifier
        }
        guard !candidates.isEmpty else { return }
        guard let preferred = candidates.first(where: { process in
            let identity = "\(process.displayName) \(process.bundleIdentifier)".lowercased()
            return identity.contains("cannabeats") || identity.contains("spotify") ||
                identity.contains("webkit") || identity.contains("safari") ||
                identity.contains("chrome") || identity.contains("firefox") ||
                identity.contains("edge")
        }) else {
            audioStatus = "New audio appeared, but its source is unclear. Use the troubleshooting process picker if CannaBeats is playing."
            return
        }
        selectedAudioProcessID = preferred.objectID
        processDiscoveryTimer?.invalidate()
        processDiscoveryTimer = nil
        audioStatus = "Detected \(preferred.displayName). Starting shared audio…"
        Task { await startSharedAudio() }
    }

    private func installedPWA(for origin: URL) -> URL? {
        let applications = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Applications", isDirectory: true)
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: applications,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else { return nil }
        for application in entries where application.pathExtension == "app" {
            let infoURL = application
                .appendingPathComponent("Contents", isDirectory: true)
                .appendingPathComponent("Info.plist")
            guard let data = try? Data(contentsOf: infoURL),
                  let raw = try? PropertyListSerialization.propertyList(from: data, format: nil),
                  let info = raw as? [String: Any],
                  let manifest = info["Manifest"] as? [String: Any],
                  let startText = manifest["start_url"] as? String,
                  let startURL = URL(string: startText),
                  startURL.host == origin.host else { continue }
            return application
        }
        return nil
    }
}
