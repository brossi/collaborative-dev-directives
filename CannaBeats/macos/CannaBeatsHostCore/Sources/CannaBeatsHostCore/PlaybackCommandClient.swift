import Foundation

public enum PlaybackCommandState: String, Codable, Equatable, Sendable {
    case queued
    case claimed
    case executing
    case completed
    case failed
    case outcomeUnknown = "outcome_unknown"
    case cancelled
}

public struct PlaybackCommand: Codable, Equatable, Sendable {
    public let claimGeneration: UUID?
    public let commandId: UUID
    public let executionAmbiguous: Bool
    public let gameId: UUID
    public let kind: PlaybackCommandKind
    public let state: PlaybackCommandState
    public let trackUri: String?
    public let updatedAt: Int64
}

public enum PlaybackCommandClientError: Error, Equatable, Sendable {
    case noApplicationSession
    case invalidResponse
    case responseLost
    case server(PlaybackServerFailure)
}

public enum PlaybackServerFailure: String, Equatable, Sendable {
    case invalidRequest = "invalid_request"
    case unauthorized
    case requestConflict = "request_conflict"
    case gameEnded = "game_ended"
    case commandNotFound = "command_not_found"
    case operationRejected = "operation_rejected"
    case staleClaim = "stale_claim"
    case playbackCapacity = "playback_capacity"
    case transitionCapacity = "transition_capacity"
    case incompatibleClient = "incompatible_client"
    case databaseUnavailable = "database_unavailable"
    case databaseCorrupt = "database_corrupt"
}

public struct PlaybackTransitionReceipt: Equatable, Sendable {
    public let command: PlaybackCommand
    public let reconcileRequired: Bool
    public let sequence: Int
}

public actor PlaybackCommandClient {
    public static let contractHeader = "x-cannabeats-playback-contract"
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

    public func next(gameID: UUID) async throws -> PlaybackCommand? {
        var request = URLRequest(url: try endpoint(
            "/api/games/\(Self.wire(gameID))/playback/commands/next"
        ))
        request.timeoutInterval = 5
        authorize(&request, bearer: try requiredSession())
        let data = try await send(request)
        guard let object = object(data), let code = object["code"] as? String else {
            throw PlaybackCommandClientError.invalidResponse
        }
        if code == "idle" {
            guard Set(object.keys) == ["code"] else {
                throw PlaybackCommandClientError.invalidResponse
            }
            return nil
        }
        guard code == "command", Set(object.keys) == ["code", "command"],
              let commandObject = object["command"] as? [String: Any],
              Set(commandObject.keys) == commandKeys,
              let commandData = try? JSONSerialization.data(withJSONObject: commandObject),
              let command = try? JSONDecoder().decode(PlaybackCommand.self, from: commandData),
              valid(command), open(command), command.gameId == gameID else {
            throw PlaybackCommandClientError.invalidResponse
        }
        return command
    }

    public func transition(
        gameID: UUID,
        commandID: UUID,
        claimGeneration: UUID,
        targetState: PlaybackCommandState,
        outcome: SpotifyReadback? = nil,
        outcomeHash: String? = nil,
        reasonCode: SpotifyControllerFailure? = nil
    ) async throws -> PlaybackTransitionReceipt {
        let wire = TransitionRequest(
            claimGeneration: claimGeneration, outcome: outcome, outcomeHash: outcomeHash,
            reasonCode: reasonCode, targetState: targetState
        )
        guard valid(wire) else { throw PlaybackCommandClientError.invalidResponse }
        var request = URLRequest(url: try endpoint(
            "/api/games/\(Self.wire(gameID))/playback/commands/\(Self.wire(commandID))/transitions"
        ))
        request.httpMethod = "POST"
        request.timeoutInterval = 5
        request.httpBody = try JSONEncoder.canonicalPlayback.encode(wire)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        authorize(&request, bearer: try requiredSession())
        let data = try await send(request)
        guard let object = object(data), Set(object.keys) == [
            "code", "command", "reconcileRequired", "transition",
        ], object["code"] as? String == "accepted",
              let commandObject = object["command"] as? [String: Any],
              Set(commandObject.keys) == commandKeys,
              let transitionObject = object["transition"] as? [String: Any],
              Set(transitionObject.keys) == transitionKeys,
              strictReadback(transitionObject["outcome"], expected: outcome),
              let decoded = try? JSONDecoder().decode(TransitionResponse.self, from: data),
              valid(decoded.command), decoded.command.commandId == commandID,
              decoded.command.gameId == gameID,
              decoded.command.state == targetState,
              decoded.command.claimGeneration == claimGeneration,
              decoded.transition.claimGeneration == claimGeneration,
              decoded.transition.toState == targetState,
              validTransition(from: decoded.transition.fromState, to: targetState),
              decoded.transition.outcome == outcome,
              decoded.transition.outcomeHash == outcomeHash,
              decoded.transition.reasonCode == reasonCode,
              decoded.transition.sequence > 0,
              decoded.reconcileRequired
                == (targetState == .claimed && decoded.transition.fromState != .queued) else {
            throw PlaybackCommandClientError.invalidResponse
        }
        return PlaybackTransitionReceipt(
            command: decoded.command,
            reconcileRequired: decoded.reconcileRequired,
            sequence: decoded.transition.sequence
        )
    }

    private func requiredSession() throws -> String {
        guard let value = try loadSession(), !value.isEmpty else {
            throw PlaybackCommandClientError.noApplicationSession
        }
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
                    throw PlaybackCommandClientError.invalidResponse
                }
                if !(200..<300).contains(response.statusCode) {
                    if let failure = object(data), Set(failure.keys) == ["code", "ok"],
                       failure["ok"] as? Bool == false,
                       let code = failure["code"] as? String,
                       let finite = PlaybackServerFailure(rawValue: code),
                       validStatus(response.statusCode, for: finite) {
                        throw PlaybackCommandClientError.server(finite)
                    }
                    throw PlaybackCommandClientError.invalidResponse
                }
                return data
            } catch let error as PlaybackCommandClientError {
                throw error
            } catch {
                if attempt == 1 { throw PlaybackCommandClientError.responseLost }
            }
        }
        throw PlaybackCommandClientError.responseLost
    }

    private func endpoint(_ path: String) throws -> URL {
        guard origin.scheme == "https", origin.host != nil, origin.path.isEmpty,
              origin.query == nil, origin.fragment == nil,
              let result = URL(string: path, relativeTo: origin)?.absoluteURL else {
            throw PlaybackCommandClientError.invalidResponse
        }
        return result
    }

    private func object(_ data: Data) -> [String: Any]? {
        try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func strictReadback(_ raw: Any?, expected: SpotifyReadback?) -> Bool {
        if expected == nil { return raw is NSNull }
        guard let object = raw as? [String: Any],
              Set(object.keys) == ["playerState", "positionMilliseconds", "trackUri"],
              let data = try? JSONSerialization.data(withJSONObject: object),
              let decoded = try? JSONDecoder().decode(SpotifyReadback.self, from: data) else {
            return false
        }
        return decoded == expected
    }

    private func validStatus(_ status: Int, for failure: PlaybackServerFailure) -> Bool {
        switch failure {
        case .invalidRequest: status == 400
        case .unauthorized: status == 401
        case .commandNotFound: status == 404
        case .gameEnded: status == 410
        case .requestConflict, .operationRejected, .staleClaim, .playbackCapacity,
             .transitionCapacity, .incompatibleClient: status == 409
        case .databaseUnavailable, .databaseCorrupt: status == 503
        }
    }

    private func valid(_ command: PlaybackCommand) -> Bool {
        let validAmbiguity = switch command.state {
        case .queued: !command.executionAmbiguous
        case .executing, .outcomeUnknown: command.executionAmbiguous
        case .claimed, .completed, .failed, .cancelled: true
        }
        return validAmbiguity && command.updatedAt > 0 && ((command.kind == .playTrack
            && command.trackUri?.range(
                of: #"^spotify:track:[0-9A-Za-z]{22}$"#,
                options: .regularExpression
            ) != nil) || (command.kind != .playTrack && command.trackUri == nil))
    }

    private func open(_ command: PlaybackCommand) -> Bool {
        switch command.state {
        case .queued: command.claimGeneration == nil
        case .claimed, .executing, .outcomeUnknown: command.claimGeneration != nil
        case .completed, .failed, .cancelled: false
        }
    }

    private func valid(_ request: TransitionRequest) -> Bool {
        switch request.targetState {
        case .claimed, .executing:
            return request.outcome == nil && request.outcomeHash == nil
                && request.reasonCode == nil
        case .completed:
            return request.outcome != nil && request.outcomeHash?.range(
                of: #"^[0-9a-f]{64}$"#,
                options: .regularExpression
            ) != nil && request.reasonCode == nil
        case .failed:
            return request.outcome == nil && request.outcomeHash == nil
                && request.reasonCode != nil
        case .outcomeUnknown:
            guard let reason = request.reasonCode else { return false }
            return request.outcome == nil && request.outcomeHash == nil
                && [.commandTimeout, .responseLost, .unrecognized].contains(reason)
        case .queued, .cancelled: return false
        }
    }

    private func validTransition(
        from: PlaybackCommandState,
        to: PlaybackCommandState
    ) -> Bool {
        switch to {
        case .claimed:
            return [.queued, .claimed, .executing, .outcomeUnknown].contains(from)
        case .executing: return from == .claimed
        case .completed, .failed:
            return [.claimed, .executing, .outcomeUnknown].contains(from)
        case .outcomeUnknown: return [.claimed, .executing].contains(from)
        case .queued, .cancelled: return false
        }
    }

    private static func wire(_ identifier: UUID) -> String {
        identifier.uuidString.lowercased()
    }

    private var commandKeys: Set<String> {
        [
            "claimGeneration", "commandId", "executionAmbiguous", "gameId", "kind",
            "state", "trackUri", "updatedAt",
        ]
    }

    private var transitionKeys: Set<String> {
        ["claimGeneration", "fromState", "outcome", "outcomeHash", "reasonCode", "sequence", "toState"]
    }
}

@MainActor
public final class PlaybackCommandRunner {
    public enum Result: Equatable, Sendable {
        case idle
        case completed
        case failed(SpotifyControllerFailure)
        case outcomeUnknown(SpotifyControllerFailure)
    }

    public let claimGeneration: UUID
    private let client: PlaybackCommandClient
    private let coordinator: SpotifyPlaybackCoordinator

    public init(
        client: PlaybackCommandClient,
        controller: any SpotifyControlling,
        claimGeneration: UUID = UUID()
    ) {
        self.client = client
        self.coordinator = SpotifyPlaybackCoordinator(controller: controller)
        self.claimGeneration = claimGeneration
    }

    public func runNext(gameID: UUID) async throws -> Result {
        guard let command = try await client.next(gameID: gameID) else { return .idle }
        let claimed = try await client.transition(
            gameID: gameID, commandID: command.commandId,
            claimGeneration: claimGeneration, targetState: .claimed
        )
        let allowExecution = !command.executionAmbiguous
            && !claimed.command.executionAmbiguous
        if allowExecution {
            _ = try await client.transition(
                gameID: gameID, commandID: command.commandId,
                claimGeneration: claimGeneration, targetState: .executing
            )
        }
        let outcome = await coordinator.perform(SpotifyPlaybackIntent(
            kind: command.kind, trackUri: command.trackUri
        ), allowExecution: allowExecution)
        switch outcome {
        case .accepted(let readback, let outcomeHash):
            _ = try await client.transition(
                gameID: gameID, commandID: command.commandId,
                claimGeneration: claimGeneration, targetState: .completed,
                outcome: readback, outcomeHash: outcomeHash
            )
            return .completed
        case .failed(let reason):
            _ = try await client.transition(
                gameID: gameID, commandID: command.commandId,
                claimGeneration: claimGeneration, targetState: .failed,
                reasonCode: reason
            )
            return .failed(reason)
        case .outcomeUnknown(let reason):
            _ = try await client.transition(
                gameID: gameID, commandID: command.commandId,
                claimGeneration: claimGeneration, targetState: .outcomeUnknown,
                reasonCode: reason
            )
            return .outcomeUnknown(reason)
        }
    }
}

private struct TransitionRequest: Encodable {
    let claimGeneration: UUID
    let outcome: SpotifyReadback?
    let outcomeHash: String?
    let reasonCode: SpotifyControllerFailure?
    let targetState: PlaybackCommandState

    enum CodingKeys: String, CodingKey {
        case claimGeneration, outcome, outcomeHash, reasonCode, targetState
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(claimGeneration.uuidString.lowercased(), forKey: .claimGeneration)
        if let outcome { try container.encode(outcome, forKey: .outcome) }
        else { try container.encodeNil(forKey: .outcome) }
        if let outcomeHash { try container.encode(outcomeHash, forKey: .outcomeHash) }
        else { try container.encodeNil(forKey: .outcomeHash) }
        if let reasonCode { try container.encode(reasonCode.rawValue, forKey: .reasonCode) }
        else { try container.encodeNil(forKey: .reasonCode) }
        try container.encode(targetState, forKey: .targetState)
    }
}

private struct TransitionResponse: Decodable {
    let code: String
    let command: PlaybackCommand
    let reconcileRequired: Bool
    let transition: TransitionProjection
}

private struct TransitionProjection: Decodable {
    let claimGeneration: UUID
    let fromState: PlaybackCommandState
    let outcome: SpotifyReadback?
    let outcomeHash: String?
    let reasonCode: SpotifyControllerFailure?
    let sequence: Int
    let toState: PlaybackCommandState
}

extension JSONEncoder {
    fileprivate static var canonicalPlayback: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}

private func wire(_ identifier: UUID) -> String {
    identifier.uuidString.lowercased()
}
