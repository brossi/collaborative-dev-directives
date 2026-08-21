import Foundation

public enum AudioSessionState: String, Codable, Equatable, Sendable {
    case starting
    case connecting
    case active
    case interrupted
    case ended
}

public struct AudioSessionProjection: Codable, Equatable, Sendable {
    public let audioSessionId: UUID
    public let connectionId: UUID?
    public let gameId: UUID
    public let generation: Int
    public let state: AudioSessionState
    public let updatedAt: Int64

    public init(
        audioSessionId: UUID, connectionId: UUID?, gameId: UUID,
        generation: Int, state: AudioSessionState, updatedAt: Int64
    ) {
        self.audioSessionId = audioSessionId
        self.connectionId = connectionId
        self.gameId = gameId
        self.generation = generation
        self.state = state
        self.updatedAt = updatedAt
    }
}

public enum AudioSessionServerFailure: String, Equatable, Sendable {
    case invalidRequest = "invalid_request"
    case unauthorized
    case requestConflict = "request_conflict"
    case gameInactive = "game_inactive"
    case audioSessionOpen = "audio_session_open"
    case audioSessionNotFound = "audio_session_not_found"
    case audioBusy = "audio_busy"
    case audioCapacity = "audio_capacity"
    case staleGeneration = "stale_generation"
    case operationRejected = "operation_rejected"
    case transitionCapacity = "transition_capacity"
    case incompatibleClient = "incompatible_client"
    case audioUnavailable = "audio_unavailable"
    case databaseUnavailable = "database_unavailable"
    case databaseCorrupt = "database_corrupt"
}

public enum AudioSessionClientError: Error, Equatable, Sendable {
    case noApplicationSession
    case invalidResponse
    case responseLost
    case server(AudioSessionServerFailure)
}

private struct AudioSessionEnvelope: Decodable {
    let code: String
    let session: AudioSessionProjection
}

private struct OpenAudioSessionRequest: Encodable {
    let audioSessionId: String
    let requestId: String
}

private struct EndAudioSessionRequest: Encodable {
    let requestId: String
}

public actor AudioSessionClient {
    public static let contractHeader = "x-cannabeats-audio-contract"
    public static let contractVersion = "1"

    private let origin: URL
    private let transport: @Sendable (URLRequest) async throws -> (Data, URLResponse)
    private let loadSession: @Sendable () throws -> String?

    public init(
        origin: URL = HostAuthorityProtocol.productionOrigin,
        transport: @escaping @Sendable (URLRequest) async throws -> (Data, URLResponse) = {
            try await URLSession.shared.data(for: $0)
        },
        loadSession: @escaping @Sendable () throws -> String? = {
            try HostCredentials.applicationSession()
        }
    ) {
        self.origin = origin
        self.transport = transport
        self.loadSession = loadSession
    }

    public func current(gameID: UUID) async throws -> AudioSessionProjection? {
        var request = URLRequest(url: try endpoint(
            "/api/games/\(wire(gameID))/audio/sessions/current"
        ))
        request.timeoutInterval = 5
        authorize(&request, bearer: try requiredSession())
        let data = try await send(request)
        guard let object = object(data), let code = object["code"] as? String else {
            throw AudioSessionClientError.invalidResponse
        }
        if code == "idle" {
            guard Set(object.keys) == ["code"] else {
                throw AudioSessionClientError.invalidResponse
            }
            return nil
        }
        return try decode(data, code: "audio_session", gameID: gameID, expectedSessionID: nil,
                          permittedStates: [.starting, .connecting, .active, .interrupted])
    }

    public func open(
        gameID: UUID, audioSessionID: UUID, requestID: UUID
    ) async throws -> AudioSessionProjection {
        var request = URLRequest(url: try endpoint(
            "/api/games/\(wire(gameID))/audio/sessions"
        ))
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.httpBody = try JSONEncoder.canonicalAudio.encode(OpenAudioSessionRequest(
            audioSessionId: wire(audioSessionID), requestId: wire(requestID)
        ))
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        authorize(&request, bearer: try requiredSession())
        let data = try await send(request)
        return try decode(data, code: "audio_session", gameID: gameID,
                          expectedSessionID: audioSessionID,
                          permittedStates: [.starting, .connecting, .active, .interrupted])
    }

    public func end(
        gameID: UUID, audioSessionID: UUID, requestID: UUID
    ) async throws -> AudioSessionProjection {
        var request = URLRequest(url: try endpoint(
            "/api/games/\(wire(gameID))/audio/sessions/\(wire(audioSessionID))/end"
        ))
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.httpBody = try JSONEncoder.canonicalAudio.encode(EndAudioSessionRequest(
            requestId: wire(requestID)
        ))
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        authorize(&request, bearer: try requiredSession())
        let data = try await send(request)
        return try decode(data, code: "ended", gameID: gameID,
                          expectedSessionID: audioSessionID, permittedStates: [.ended])
    }

    private func requiredSession() throws -> String {
        guard let value = try loadSession(), value.range(
            of: #"^[A-Za-z0-9_-]{22,128}$"#, options: .regularExpression
        ) != nil else { throw AudioSessionClientError.noApplicationSession }
        return value
    }

    private func authorize(_ request: inout URLRequest, bearer: String) {
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        request.setValue(Self.contractVersion, forHTTPHeaderField: Self.contractHeader)
    }

    private func send(_ request: URLRequest) async throws -> Data {
        for attempt in 0..<2 {
            do {
                let (data, rawResponse) = try await transport(request)
                guard data.count <= 64 * 1_024,
                      let response = rawResponse as? HTTPURLResponse else {
                    throw AudioSessionClientError.invalidResponse
                }
                if !(200..<300).contains(response.statusCode) {
                    if let failure = object(data), Set(failure.keys) == ["code", "ok"],
                       failure["ok"] as? Bool == false,
                       let code = failure["code"] as? String,
                       let finite = AudioSessionServerFailure(rawValue: code),
                       validStatus(response.statusCode, for: finite) {
                        throw AudioSessionClientError.server(finite)
                    }
                    throw AudioSessionClientError.invalidResponse
                }
                return data
            } catch let error as AudioSessionClientError {
                throw error
            } catch {
                if attempt == 1 { throw AudioSessionClientError.responseLost }
            }
        }
        throw AudioSessionClientError.responseLost
    }

    private func decode(
        _ data: Data, code: String, gameID: UUID, expectedSessionID: UUID?,
        permittedStates: Set<AudioSessionState>
    ) throws -> AudioSessionProjection {
        guard let raw = object(data), Set(raw.keys) == ["code", "session"],
              raw["code"] as? String == code,
              let rawSession = raw["session"] as? [String: Any],
              Set(rawSession.keys) == [
                "audioSessionId", "connectionId", "gameId", "generation", "state", "updatedAt",
              ],
              let encoded = try? JSONSerialization.data(withJSONObject: raw),
              let envelope = try? JSONDecoder().decode(AudioSessionEnvelope.self, from: encoded),
              envelope.code == code,
              valid(envelope.session), envelope.session.gameId == gameID,
              expectedSessionID == nil || envelope.session.audioSessionId == expectedSessionID,
              permittedStates.contains(envelope.session.state),
              rawSession["audioSessionId"] as? String == wire(envelope.session.audioSessionId),
              rawSession["gameId"] as? String == wire(envelope.session.gameId),
              ((rawSession["connectionId"] is NSNull && envelope.session.connectionId == nil)
                || rawSession["connectionId"] as? String
                    == envelope.session.connectionId.map(wire)) else {
            throw AudioSessionClientError.invalidResponse
        }
        return envelope.session
    }

    private func valid(_ session: AudioSessionProjection) -> Bool {
        guard session.generation > 0, session.updatedAt > 0 else { return false }
        switch session.state {
        case .connecting, .active: return session.connectionId != nil
        case .starting, .interrupted, .ended: return session.connectionId == nil
        }
    }

    private func validStatus(_ status: Int, for failure: AudioSessionServerFailure) -> Bool {
        switch failure {
        case .invalidRequest: status == 400
        case .unauthorized: status == 401
        case .audioSessionNotFound: status == 404
        case .requestConflict, .gameInactive, .audioSessionOpen, .audioBusy,
             .audioCapacity, .staleGeneration, .operationRejected, .transitionCapacity,
             .incompatibleClient: status == 409
        case .audioUnavailable, .databaseUnavailable, .databaseCorrupt: status == 503
        }
    }

    private func endpoint(_ path: String) throws -> URL {
        guard origin.scheme == "https", origin.host != nil, origin.path.isEmpty,
              origin.query == nil, origin.fragment == nil,
              let result = URL(string: path, relativeTo: origin)?.absoluteURL else {
            throw AudioSessionClientError.invalidResponse
        }
        return result
    }

    private func object(_ data: Data) -> [String: Any]? {
        try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func wire(_ identifier: UUID) -> String {
        identifier.uuidString.lowercased()
    }
}

private extension JSONEncoder {
    static var canonicalAudio: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}
