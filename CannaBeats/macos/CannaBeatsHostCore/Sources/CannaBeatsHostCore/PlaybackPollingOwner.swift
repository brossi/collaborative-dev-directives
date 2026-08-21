import Foundation

public enum PlaybackOwnerEvent: Equatable, Sendable {
    case idle
    case completed
    case failed(SpotifyControllerFailure)
    case outcomeUnknown(SpotifyControllerFailure)
    case clientFailure(PlaybackCommandClientError)
}

@MainActor
public final class PlaybackPollingOwner {
    private let gameID: UUID
    private let pollInterval: Duration
    private let runner: PlaybackCommandRunner
    private var pollingTask: Task<Void, Never>?

    public init(
        gameID: UUID,
        client: PlaybackCommandClient,
        controller: any SpotifyControlling,
        claimGeneration: UUID = UUID(),
        pollInterval: Duration = .seconds(1)
    ) {
        self.gameID = gameID
        self.pollInterval = pollInterval
        self.runner = PlaybackCommandRunner(
            client: client, controller: controller, claimGeneration: claimGeneration
        )
    }

    public convenience init(
        gameID: UUID,
        origin: URL = HostAuthorityProtocol.productionOrigin,
        pollInterval: Duration = .seconds(1)
    ) {
        self.init(
            gameID: gameID,
            client: PlaybackCommandClient(origin: origin),
            controller: AppleEventSpotifyController(),
            pollInterval: pollInterval
        )
    }

    public func pollOnce() async -> PlaybackOwnerEvent {
        do {
            switch try await runner.runNext(gameID: gameID) {
            case .idle: return .idle
            case .completed: return .completed
            case .failed(let reason): return .failed(reason)
            case .outcomeUnknown(let reason): return .outcomeUnknown(reason)
            }
        } catch let error as PlaybackCommandClientError {
            return .clientFailure(error)
        } catch {
            return .clientFailure(.invalidResponse)
        }
    }

    public func start(
        report: @escaping @MainActor @Sendable (PlaybackOwnerEvent) -> Void
    ) {
        guard pollingTask == nil else { return }
        pollingTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                report(await self.pollOnce())
                try? await Task.sleep(for: self.pollInterval)
            }
        }
    }

    public func stop() {
        pollingTask?.cancel()
        pollingTask = nil
    }

    deinit { pollingTask?.cancel() }
}
