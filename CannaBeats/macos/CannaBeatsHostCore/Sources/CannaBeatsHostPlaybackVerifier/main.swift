import CannaBeatsHostCore
import Foundation

private let expectedURI = "spotify:track:ABCDEFGHIJKLMNOPQRSTUV"
private let otherURI = "spotify:track:ZYXWVUTSRQPONMLKJIHGFE"

@MainActor
private final class FakeSpotifyController: SpotifyControlling {
    var state: SpotifyApplicationState = .running
    var readbacks: [SpotifyControllerResult<SpotifyReadback>] = []
    var executionFailure: SpotifyControllerFailure?
    var calls: [String] = []

    func applicationState() -> SpotifyApplicationState { state }

    func readback() async -> SpotifyControllerResult<SpotifyReadback> {
        calls.append("readback")
        return readbacks.isEmpty ? .failure(.unrecognized) : readbacks.removeFirst()
    }

    func playTrack(uri: String) async -> SpotifyControllerResult<Void> {
        calls.append("play_track:\(uri)")
        return executionFailure.map(SpotifyControllerResult.failure) ?? .success(())
    }

    func play() async -> SpotifyControllerResult<Void> {
        calls.append("play")
        return executionFailure.map(SpotifyControllerResult.failure) ?? .success(())
    }

    func pause() async -> SpotifyControllerResult<Void> {
        calls.append("pause")
        return executionFailure.map(SpotifyControllerResult.failure) ?? .success(())
    }
}

private func readback(
    _ state: SpotifyPlayerState,
    uri: String? = expectedURI,
    position: Int64 = 1_250
) -> SpotifyReadback {
    SpotifyReadback(playerState: state, positionMilliseconds: position, trackUri: uri)
}

@MainActor
private func verifyCoordinator() async {
    let fake = FakeSpotifyController()
    fake.readbacks = [.success(readback(.paused)), .success(readback(.playing))]
    let outcome = await SpotifyPlaybackCoordinator(controller: fake).perform(
        SpotifyPlaybackIntent(kind: .playTrack, trackUri: expectedURI)
    )
    guard case .accepted(let verified, let hash) = outcome else {
        preconditionFailure("play_track did not complete")
    }
    precondition(verified == readback(.playing))
    precondition(hash == "76f5a02e5fc611c712f9e256b7c0e0706f5173ed7fb4749b7a18ea9bf978c669")
    precondition(fake.calls == ["readback", "play_track:\(expectedURI)", "readback"])

    let reconciled = FakeSpotifyController()
    reconciled.readbacks = [.success(readback(.playing))]
    guard case .accepted = await SpotifyPlaybackCoordinator(controller: reconciled).perform(
        SpotifyPlaybackIntent(kind: .playTrack, trackUri: expectedURI)
    ) else { preconditionFailure("retained desired state did not reconcile") }
    precondition(reconciled.calls == ["readback"])

    let play = FakeSpotifyController()
    play.readbacks = [.success(readback(.paused)), .success(readback(.playing))]
    guard case .accepted = await SpotifyPlaybackCoordinator(controller: play).perform(
        SpotifyPlaybackIntent(kind: .play)
    ) else { preconditionFailure("play did not verify") }
    precondition(play.calls == ["readback", "play", "readback"])

    let pause = FakeSpotifyController()
    pause.readbacks = [.success(readback(.playing)), .success(readback(.paused))]
    guard case .accepted = await SpotifyPlaybackCoordinator(controller: pause).perform(
        SpotifyPlaybackIntent(kind: .pause)
    ) else { preconditionFailure("pause did not verify") }
    precondition(pause.calls == ["readback", "pause", "readback"])
}

@MainActor
private func verifyFiniteOutcomes() async {
    let missing = FakeSpotifyController()
    missing.state = .missing
    let missingOutcome = await SpotifyPlaybackCoordinator(controller: missing).perform(
        SpotifyPlaybackIntent(kind: .play)
    )
    precondition(missingOutcome == .failed(.spotifyMissing))

    let stopped = FakeSpotifyController()
    stopped.state = .notRunning
    let stoppedOutcome = await SpotifyPlaybackCoordinator(controller: stopped).perform(
        SpotifyPlaybackIntent(kind: .play)
    )
    precondition(stoppedOutcome == .failed(.spotifyNotRunning))

    let signedOut = FakeSpotifyController()
    signedOut.readbacks = [.failure(.spotifySignedOut)]
    let signedOutOutcome = await SpotifyPlaybackCoordinator(controller: signedOut).perform(
        SpotifyPlaybackIntent(kind: .play)
    )
    precondition(signedOutOutcome == .failed(.spotifySignedOut))

    for failure in [SpotifyControllerFailure.automationDenied, .unrecognized] {
        let driver = FakeSpotifyController()
        driver.readbacks = [.success(readback(.paused))]
        driver.executionFailure = failure
        let outcome = await SpotifyPlaybackCoordinator(controller: driver).perform(
            SpotifyPlaybackIntent(kind: .play)
        )
        precondition(outcome == .failed(failure))
    }

    for failure in [SpotifyControllerFailure.commandTimeout, .responseLost] {
        let driver = FakeSpotifyController()
        driver.readbacks = [.success(readback(.paused))]
        driver.executionFailure = failure
        let outcome = await SpotifyPlaybackCoordinator(controller: driver).perform(
            SpotifyPlaybackIntent(kind: .play)
        )
        precondition(outcome == .outcomeUnknown(failure))
    }

    let mismatch = FakeSpotifyController()
    mismatch.readbacks = [
        .success(readback(.paused)), .success(readback(.playing, uri: otherURI)),
    ]
    let mismatchOutcome = await SpotifyPlaybackCoordinator(controller: mismatch).perform(
        SpotifyPlaybackIntent(kind: .playTrack, trackUri: expectedURI)
    )
    precondition(mismatchOutcome == .failed(.unexpectedTrack))
}

private actor RunnerTransport {
    let gameID: UUID
    let commandID: UUID
    private var transitionBodies: [Data] = []
    private var sequence = 1
    private var state: String
    private var generation: String?
    private var executionAmbiguous: Bool
    private var concurrentStateBeforeClaim: String?
    private let claimResponseAmbiguity: Bool?

    init(
        gameID: UUID, commandID: UUID,
        state: String = "queued", generation: UUID? = nil,
        concurrentStateBeforeClaim: String? = nil,
        claimResponseAmbiguity: Bool? = nil
    ) {
        self.gameID = gameID
        self.commandID = commandID
        self.state = state
        self.generation = generation?.uuidString.lowercased()
        self.executionAmbiguous = ["executing", "outcome_unknown"].contains(state)
        self.concurrentStateBeforeClaim = concurrentStateBeforeClaim
        self.claimResponseAmbiguity = claimResponseAmbiguity
    }

    func send(_ request: URLRequest) throws -> (Data, URLResponse) {
        precondition(request.value(forHTTPHeaderField: PlaybackCommandClient.contractHeader) == "1")
        precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer retained-session")
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil
        )!
        if request.httpMethod == "GET" {
            if ["completed", "failed", "cancelled"].contains(state) {
                return (Data(#"{"code":"idle"}"#.utf8), response)
            }
            return (try JSONSerialization.data(withJSONObject: [
                "code": "command", "command": command(state: state, generation: generation),
            ]), response)
        }
        let body = request.httpBody ?? Data()
        transitionBodies.append(body)
        let input = try JSONSerialization.jsonObject(with: body) as! [String: Any]
        precondition(Set(input.keys) == [
            "claimGeneration", "outcome", "outcomeHash", "reasonCode", "targetState",
        ])
        if input["targetState"] as? String == "claimed",
           let concurrentStateBeforeClaim {
            state = concurrentStateBeforeClaim
            executionAmbiguous = ["executing", "outcome_unknown"]
                .contains(concurrentStateBeforeClaim)
            self.concurrentStateBeforeClaim = nil
        }
        let from = state
        state = input["targetState"] as! String
        if ["executing", "outcome_unknown"].contains(state) {
            executionAmbiguous = true
        }
        sequence += 1
        generation = input["claimGeneration"] as? String
        var responseCommand = command(state: state, generation: generation!)
        if state == "claimed", let claimResponseAmbiguity {
            responseCommand["executionAmbiguous"] = claimResponseAmbiguity
        }
        return (try JSONSerialization.data(withJSONObject: [
            "code": "accepted",
            "command": responseCommand,
            "reconcileRequired": state == "claimed" && from != "queued",
            "transition": [
                "claimGeneration": generation!, "fromState": from,
                "outcome": input["outcome"]!, "outcomeHash": input["outcomeHash"]!,
                "reasonCode": input["reasonCode"]!,
                "sequence": sequence, "toState": state,
            ],
        ]), response)
    }

    func bodies() -> [Data] { transitionBodies }

    private func command(state: String, generation: String?) -> [String: Any] {
        [
            "claimGeneration": generation ?? NSNull(),
            "commandId": commandID.uuidString.lowercased(),
            "executionAmbiguous": executionAmbiguous,
            "gameId": gameID.uuidString.lowercased(),
            "kind": "play_track", "state": state, "trackUri": expectedURI,
            "updatedAt": 2_000,
        ]
    }
}

@MainActor
private func verifyRunner() async throws {
    let gameID = UUID()
    let commandID = UUID()
    let transport = RunnerTransport(gameID: gameID, commandID: commandID)
    let client = PlaybackCommandClient(
        transport: { try await transport.send($0) },
        loadSession: { "retained-session" }
    )
    let spotify = FakeSpotifyController()
    spotify.readbacks = [.success(readback(.paused)), .success(readback(.playing))]
    let generation = UUID()
    let runner = PlaybackCommandRunner(
        client: client, controller: spotify, claimGeneration: generation
    )
    let runResult = try await runner.runNext(gameID: gameID)
    precondition(runResult == .completed)
    let bodies = try await transport.bodies().map {
        try JSONSerialization.jsonObject(with: $0) as! [String: Any]
    }
    precondition(bodies.map { $0["targetState"] as! String }
        == ["claimed", "executing", "completed"])
    precondition(bodies.allSatisfy {
        $0["claimGeneration"] as? String == generation.uuidString.lowercased()
    })
    precondition(bodies[0]["outcome"] is NSNull
        && bodies[0]["outcomeHash"] is NSNull && bodies[0]["reasonCode"] is NSNull)
    precondition((bodies[2]["outcome"] as? [String: Any])?["trackUri"] as? String == expectedURI)
    precondition((bodies[2]["outcomeHash"] as? String)?.count == 64)

    let ambiguousSpotify = FakeSpotifyController()
    ambiguousSpotify.readbacks = [.success(readback(.paused))]
    let ambiguousGeneration = UUID()
    let ambiguousTransport = RunnerTransport(
        gameID: gameID, commandID: UUID(), state: "outcome_unknown",
        generation: ambiguousGeneration, claimResponseAmbiguity: false
    )
    let ambiguousClient = PlaybackCommandClient(
        transport: { try await ambiguousTransport.send($0) },
        loadSession: { "retained-session" }
    )
    let ambiguousRunner = PlaybackCommandRunner(
        client: ambiguousClient, controller: ambiguousSpotify,
        claimGeneration: ambiguousGeneration
    )
    let ambiguousResult = try await ambiguousRunner.runNext(gameID: gameID)
    precondition(ambiguousResult == .outcomeUnknown(.unrecognized))
    precondition(ambiguousSpotify.calls == ["readback"])
    let ambiguousBodies = try await ambiguousTransport.bodies().map {
        try JSONSerialization.jsonObject(with: $0) as! [String: Any]
    }
    precondition(ambiguousBodies.map { $0["targetState"] as! String }
        == ["claimed", "outcome_unknown"])

    let racingSpotify = FakeSpotifyController()
    racingSpotify.readbacks = [.success(readback(.paused))]
    let racingTransport = RunnerTransport(
        gameID: gameID, commandID: UUID(), concurrentStateBeforeClaim: "outcome_unknown"
    )
    let racingRunner = PlaybackCommandRunner(
        client: PlaybackCommandClient(
            transport: { try await racingTransport.send($0) },
            loadSession: { "retained-session" }
        ),
        controller: racingSpotify
    )
    let racingResult = try await racingRunner.runNext(gameID: gameID)
    precondition(racingResult == .outcomeUnknown(.unrecognized))
    precondition(racingSpotify.calls == ["readback"])
    let racingBodies = try await racingTransport.bodies().map {
        try JSONSerialization.jsonObject(with: $0) as! [String: Any]
    }
    precondition(racingBodies.map { $0["targetState"] as! String }
        == ["claimed", "outcome_unknown"])
}

private actor LossyTransitionTransport {
    private var requests: [URLRequest] = []
    let gameID: UUID
    let commandID: UUID
    let generation: UUID

    init(gameID: UUID, commandID: UUID, generation: UUID) {
        self.gameID = gameID
        self.commandID = commandID
        self.generation = generation
    }

    func send(_ request: URLRequest) throws -> (Data, URLResponse) {
        requests.append(request)
        if requests.count == 1 { throw URLError(.networkConnectionLost) }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil
        )!
        return (try JSONSerialization.data(withJSONObject: [
            "code": "accepted",
            "command": [
                "claimGeneration": generation.uuidString.lowercased(),
                "commandId": commandID.uuidString.lowercased(),
                "executionAmbiguous": false,
                "gameId": gameID.uuidString.lowercased(), "kind": "play_track",
                "state": "claimed", "trackUri": expectedURI, "updatedAt": 2_000,
            ],
            "reconcileRequired": false,
            "transition": [
                "claimGeneration": generation.uuidString.lowercased(),
                "fromState": "queued", "outcome": NSNull(), "outcomeHash": NSNull(),
                "reasonCode": NSNull(), "sequence": 2, "toState": "claimed",
            ],
        ]), response)
    }

    func retained() -> [URLRequest] { requests }
}

private func verifyResponseLossReplay() async throws {
    let gameID = UUID()
    let commandID = UUID()
    let generation = UUID()
    let transport = LossyTransitionTransport(
        gameID: gameID, commandID: commandID, generation: generation
    )
    let client = PlaybackCommandClient(
        transport: { try await transport.send($0) },
        loadSession: { "retained-session" }
    )
    let receipt = try await client.transition(
        gameID: gameID, commandID: commandID,
        claimGeneration: generation, targetState: .claimed
    )
    precondition(receipt.sequence == 2)
    let requests = await transport.retained()
    precondition(requests.count == 2)
    precondition(requests[0].url == requests[1].url)
    precondition(requests[0].httpBody == requests[1].httpBody)
    precondition(requests[0].value(forHTTPHeaderField: "Authorization")
        == requests[1].value(forHTTPHeaderField: "Authorization"))
}

private actor MalformedTransport {
    func send(_ request: URLRequest) -> (Data, URLResponse) {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil
        )!
        return (Data(#"{"code":"idle","nativeText":"private path"}"#.utf8), response)
    }
}

private actor StaticTransport {
    let data: Data
    let status: Int

    init(data: Data, status: Int) {
        self.data = data
        self.status = status
    }

    func send(_ request: URLRequest) -> (Data, URLResponse) {
        (data, HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil
        )!)
    }
}

private final class BlockingScriptProbe: @unchecked Sendable {
    private let lock = NSLock()
    private let releaseFirst = DispatchSemaphore(value: 0)
    private let releaseSecond = DispatchSemaphore(value: 0)
    private var invocationCount = 0

    func execute(_: String) -> SpotifyControllerResult<String> {
        let invocation = lock.withLock {
            invocationCount += 1
            return invocationCount
        }
        if invocation == 1 { releaseFirst.wait() }
        if invocation == 2 { releaseSecond.wait() }
        return .success("")
    }

    func count() -> Int { lock.withLock { invocationCount } }
    func releaseFirstInvocation() { releaseFirst.signal() }
    func releaseSecondInvocation() { releaseSecond.signal() }
}

private func verifyMalformedResponseFailsClosed() async {
    let transport = MalformedTransport()
    let client = PlaybackCommandClient(
        transport: { await transport.send($0) },
        loadSession: { "retained-session" }
    )
    do {
        _ = try await client.next(gameID: UUID())
        preconditionFailure("expanded response was accepted")
    } catch PlaybackCommandClientError.invalidResponse {
        // The native field and its content are not surfaced.
    } catch {
        preconditionFailure("expanded response did not use the finite client result")
    }
}

private func expectInvalidResponse(_ client: PlaybackCommandClient, gameID: UUID) async {
    do {
        _ = try await client.next(gameID: gameID)
        preconditionFailure("malformed response was accepted")
    } catch PlaybackCommandClientError.invalidResponse {
        // Expected finite local result.
    } catch {
        preconditionFailure("malformed response escaped the finite local result")
    }
}

private func verifyAmbiguityAndFailureResponsesFailClosed() async throws {
    let gameID = UUID()
    let malformedCommand = try JSONSerialization.data(withJSONObject: [
        "code": "command",
        "command": [
            "claimGeneration": UUID().uuidString.lowercased(),
            "commandId": UUID().uuidString.lowercased(),
            "executionAmbiguous": false,
            "gameId": gameID.uuidString.lowercased(),
            "kind": "play_track", "state": "executing", "trackUri": expectedURI,
            "updatedAt": 2_000,
        ],
    ])
    let commandTransport = StaticTransport(data: malformedCommand, status: 200)
    await expectInvalidResponse(PlaybackCommandClient(
        transport: { await commandTransport.send($0) }, loadSession: { "retained-session" }
    ), gameID: gameID)

    for body in [
        #"{"ok":false,"code":"database_unavailable","nativeText":"private"}"#,
        #"{"ok":false,"code":"unknown_lower_layer"}"#,
    ] {
        let transport = StaticTransport(data: Data(body.utf8), status: 503)
        await expectInvalidResponse(PlaybackCommandClient(
            transport: { await transport.send($0) }, loadSession: { "retained-session" }
        ), gameID: gameID)
    }

    let finite = StaticTransport(
        data: Data(#"{"ok":false,"code":"database_unavailable"}"#.utf8), status: 503
    )
    let finiteClient = PlaybackCommandClient(
        transport: { await finite.send($0) }, loadSession: { "retained-session" }
    )
    do {
        _ = try await finiteClient.next(gameID: gameID)
        preconditionFailure("finite server failure was accepted")
    } catch PlaybackCommandClientError.server(.databaseUnavailable) {
        // Exact finite response was retained.
    }

    let audioNotReady = StaticTransport(
        data: Data(#"{"ok":false,"code":"audio_not_ready"}"#.utf8), status: 409
    )
    let audioNotReadyClient = PlaybackCommandClient(
        transport: { await audioNotReady.send($0) }, loadSession: { "retained-session" }
    )
    do {
        _ = try await audioNotReadyClient.next(gameID: gameID)
        preconditionFailure("audio readiness failure was accepted")
    } catch PlaybackCommandClientError.server(.audioNotReady) {
        // Playback remains gated by the exact finite server result.
    }

    let commandID = UUID()
    let generation = UUID()
    let outcome = readback(.playing)
    let outcomeHash = "76f5a02e5fc611c712f9e256b7c0e0706f5173ed7fb4749b7a18ea9bf978c669"
    let expandedOutcome = try JSONSerialization.data(withJSONObject: [
        "code": "accepted",
        "command": [
            "claimGeneration": generation.uuidString.lowercased(),
            "commandId": commandID.uuidString.lowercased(), "executionAmbiguous": false,
            "gameId": gameID.uuidString.lowercased(), "kind": "play_track",
            "state": "completed", "trackUri": expectedURI, "updatedAt": 2_000,
        ],
        "reconcileRequired": false,
        "transition": [
            "claimGeneration": generation.uuidString.lowercased(), "fromState": "claimed",
            "outcome": [
                "playerState": "playing", "positionMilliseconds": 1_250,
                "trackUri": expectedURI, "nativeText": "private",
            ],
            "outcomeHash": outcomeHash, "reasonCode": NSNull(), "sequence": 2,
            "toState": "completed",
        ],
    ])
    let expandedTransport = StaticTransport(data: expandedOutcome, status: 200)
    let expandedClient = PlaybackCommandClient(
        transport: { await expandedTransport.send($0) }, loadSession: { "retained-session" }
    )
    do {
        _ = try await expandedClient.transition(
            gameID: gameID, commandID: commandID, claimGeneration: generation,
            targetState: PlaybackCommandState.completed,
            outcome: outcome, outcomeHash: outcomeHash
        )
        preconditionFailure("expanded nested outcome was accepted")
    } catch PlaybackCommandClientError.invalidResponse {
        // Exact nested response enforcement is fail closed.
    }
}

@MainActor
private func verifyTimedOutAppleEventBarrier() async {
    let probe = BlockingScriptProbe()
    let controller = AppleEventSpotifyController(
        timeout: .milliseconds(20), executeScript: probe.execute
    )
    switch await controller.play() {
    case .failure(.commandTimeout): break
    default: preconditionFailure("first Apple Event did not time out")
    }
    let successorController = AppleEventSpotifyController(
        timeout: .seconds(1), executeScript: probe.execute
    )
    let successor = Task { @MainActor in await successorController.pause() }
    let thirdController = AppleEventSpotifyController(
        timeout: .seconds(1), executeScript: probe.execute
    )
    let third = Task { @MainActor in await thirdController.play() }
    try? await Task.sleep(for: .milliseconds(60))
    precondition(probe.count() == 1)
    probe.releaseFirstInvocation()
    try? await Task.sleep(for: .milliseconds(60))
    precondition(probe.count() == 2)
    probe.releaseSecondInvocation()
    switch await successor.value {
    case .success: break
    case .failure: preconditionFailure("successor Apple Event failed")
    }
    switch await third.value {
    case .success: break
    case .failure: preconditionFailure("third Apple Event failed")
    }
    precondition(probe.count() == 3)
}

private func verifyRecoveryGuidance() {
    let failures: [SpotifyControllerFailure] = [
        .spotifyMissing, .spotifyNotRunning, .spotifySignedOut, .automationDenied,
        .commandTimeout, .unexpectedTrack, .responseLost, .unrecognized,
    ]
    let guidance = failures.map(SpotifyRecoveryGuide.guidance)
    precondition(guidance.allSatisfy { !$0.message.isEmpty })
    precondition(guidance[3].route == .automationSettings)
    precondition(guidance[3].message.contains("Privacy & Security → Automation"))
}

@MainActor
private func verifyForegroundOwner() async {
    let gameID = UUID()
    let transport = RunnerTransport(gameID: gameID, commandID: UUID())
    let client = PlaybackCommandClient(
        transport: { try await transport.send($0) }, loadSession: { "retained-session" }
    )
    let spotify = FakeSpotifyController()
    spotify.readbacks = [.success(readback(.paused)), .success(readback(.playing))]
    let owner = PlaybackPollingOwner(gameID: gameID, client: client, controller: spotify)
    let completed = await owner.pollOnce()
    let idle = await owner.pollOnce()
    precondition(completed == .completed)
    precondition(idle == .idle)
}

await verifyCoordinator()
await verifyFiniteOutcomes()
try await verifyRunner()
try await verifyResponseLossReplay()
await verifyMalformedResponseFailsClosed()
try await verifyAmbiguityAndFailureResponsesFailClosed()
await verifyTimedOutAppleEventBarrier()
await verifyForegroundOwner()
verifyRecoveryGuidance()
print("spotify_playback_protocol_valid (20 checks)")
