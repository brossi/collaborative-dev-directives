import AppKit
import CannaBeatsHostCore
import SwiftUI
import WebKit

private let diagnosticsPreference = "social.cannabeats.host.diagnostics-enabled"

@MainActor
final class HostAppModel: ObservableObject {
    @Published private(set) var readiness = HostReadinessProjection.checking
    @Published private(set) var gameTicket: String?
    @Published private(set) var needsEnrollment = false
    @Published private(set) var status = "Checking this Mac…"
    @Published private(set) var diagnosticStatus = ""
    @Published var diagnosticsEnabled: Bool {
        didSet { UserDefaults.standard.set(diagnosticsEnabled, forKey: diagnosticsPreference) }
    }

    private let client: HostAuthorityClient
    private let spotify: AppleEventSpotifyController
    private let capturePermission: SystemAudioCapturePermission
    private var monitor: Task<Void, Never>?
    private var refreshInFlight = false
    private var lastAudioState: String?
    private var lastDroppedFrames: UInt64 = 0
    private lazy var gameRuntime = HostGameRuntimeOwner(reportPlayback: { [weak self] event in
        self?.recordPlayback(event)
    })

    init(
        client: HostAuthorityClient = HostAuthorityClient(),
        spotify: AppleEventSpotifyController = AppleEventSpotifyController(),
        capturePermission: SystemAudioCapturePermission = SystemAudioCapturePermission()
    ) {
        self.client = client
        self.spotify = spotify
        self.capturePermission = capturePermission
        diagnosticsEnabled = UserDefaults.standard.bool(forKey: diagnosticsPreference)
    }

    func start() async {
        status = "Checking this Mac…"
        if (try? HostCredentials.applicationSession()) == nil {
            do { _ = try await client.establishApplicationSession() }
            catch {
                needsEnrollment = true
                status = "Enroll this Mac to continue."
                await refreshLocal(server: .failure(.noApplicationSession), enrolled: false)
                return
            }
        }
        needsEnrollment = false
        await refresh(requestAudioCapture: true)
    }

    func refresh(requestAudioCapture: Bool = false) async {
        guard !refreshInFlight else { return }
        refreshInFlight = true
        defer { refreshInFlight = false }
        if requestAudioCapture { await requestCapturePermissionIfEligible() }
        let enrolled = (try? HostCredentials.applicationSession()) != nil
        var server: Result<HostServerReadiness, HostAuthorityClientError>
        do {
            server = .success(try await client.hostReadiness())
        } catch HostAuthorityClientError.server("unauthorized") {
            do {
                _ = try await client.establishApplicationSession()
                server = .success(try await client.hostReadiness())
            } catch HostAuthorityClientError.server("unauthorized") {
                needsEnrollment = true
                server = .failure(.noApplicationSession)
            } catch let error as HostAuthorityClientError {
                server = .failure(error)
            } catch { server = .failure(.transport) }
        } catch let error as HostAuthorityClientError {
            server = .failure(error)
        } catch { server = .failure(.transport) }
        await refreshLocal(
            server: server, enrolled: enrolled
        )
    }

    private func requestCapturePermissionIfEligible() async {
        let spotifyState = spotify.applicationState()
        let readback = spotifyState == .running ? await spotify.readback() : nil
        let audioCapture = capturePermission.readiness()
        if spotifyState == .running, case .success = readback, audioCapture != .ready {
            status = "Requesting System Audio Recording access…"
            _ = await capturePermission.requestReadiness()
        }
    }

    private func refreshLocal(
        server: Result<HostServerReadiness, HostAuthorityClientError>, enrolled: Bool
    ) async {
        let spotifyState = spotify.applicationState()
        let readback = spotifyState == .running ? await spotify.readback() : nil
        readiness = HostReadinessBuilder.build(
            server: server, enrolled: enrolled, spotifyState: spotifyState,
            spotifyReadback: readback, audioCapture: capturePermission.readiness()
        )
        status = readiness.primaryAction.enabled
            ? (readiness.activeGame == nil ? "Ready to create a game." : "Ready to resume the game.")
            : readiness.primaryAction.blockedBy?.message ?? "Finish the readiness checks."
        let serverReadinessConfirmed = HostGameRuntimeReconciler
            .lifecycleDecisionConfirmed(by: server)
        await reconcileGameRuntime(serverReadinessConfirmed: serverReadinessConfirmed)
        recordAudioChanges()
    }

    private func reconcileGameRuntime(serverReadinessConfirmed: Bool) async {
        switch HostGameRuntimeReconciler.directive(
            serverReadinessConfirmed: serverReadinessConfirmed,
            readiness: readiness
        ) {
        case .preserve:
            return
        case .stop:
            if gameRuntime.gameID != nil { await gameRuntime.stop() }
        case .start(let gameID):
            if gameRuntime.gameID != gameID { await gameRuntime.start(gameID: gameID) }
        }
    }

    func openGame() async {
        guard readiness.primaryAction.enabled else {
            status = readiness.primaryAction.blockedBy?.message ?? "Finish the readiness checks."
            return
        }
        do {
            let ticket = try await client.issueWebTicket()
            gameTicket = ticket.value
            status = "Host game opened."
            startMonitoring()
        } catch HostAuthorityClientError.server("upgrade_required") {
            status = HostReadinessRecovery.updateHost.message
            await refresh(requestAudioCapture: true)
        } catch {
            status = "The authenticated game window could not be opened. Try again."
        }
    }

    func reconnectAudio() {
        guard readiness.sharedAudioRuntimeEnabled else {
            status = readiness.primaryAction.blockedBy?.message ?? "Finish the readiness checks."
            return
        }
        gameRuntime.reconnectSharedAudio()
        status = "Reconnecting shared audio…"
    }

    func webSessionFailed() {
        gameTicket = nil
        status = "The authenticated game window could not be opened. Try again."
    }

    func shutdown() async {
        monitor?.cancel()
        monitor = nil
        gameTicket = nil
        await gameRuntime.stop()
    }

    func showEnrollment() { needsEnrollment = true }

    func openSpotify() {
        guard let url = NSWorkspace.shared.urlForApplication(
            withBundleIdentifier: AppleEventSpotifyController.spotifyBundleIdentifier
        ) else { return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = spotify.applicationState() == .running
        configuration.addsToRecentItems = false
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) {
            [weak self] _, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if error != nil { self.status = "Spotify could not be opened." }
                else { await self.refresh(requestAudioCapture: true) }
            }
        }
    }

    func openPrivacySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy") {
            NSWorkspace.shared.open(url)
        }
    }

    func exportDiagnostics() async {
        guard let gameID = readiness.activeGame?.gameId else {
            diagnosticStatus = "Create or resume a game before exporting diagnostics."
            return
        }
        do {
            let value = try await client.exportDiagnostics(gameID: gameID)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            let data = try encoder.encode(value)
            let panel = NSSavePanel()
            panel.allowedContentTypes = [.json]
            panel.canCreateDirectories = true
            panel.nameFieldStringValue = "CannaBeats-Diagnostics.json"
            guard panel.runModal() == .OK, let url = panel.url else { return }
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            diagnosticStatus = "Sanitized diagnostics exported."
            record(kind: .host, code: .exportCreated, metric: 1)
        } catch {
            diagnosticStatus = "Diagnostics could not be exported; gameplay was not changed."
        }
    }

    private func startMonitoring() {
        guard monitor == nil else { return }
        monitor = Task { [weak self] in
            while let self, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                if !Task.isCancelled { await self.refresh() }
            }
        }
    }

    private func recordPlayback(_ event: PlaybackOwnerEvent) {
        switch event {
        case .failed: record(kind: .game, code: .playbackFailed, metric: 1)
        case .outcomeUnknown: record(kind: .game, code: .playbackOutcomeUnknown, metric: 1)
        case .idle, .completed, .clientFailure: break
        }
    }

    private func recordAudioChanges() {
        guard let audio = gameRuntime.sharedAudio else {
            lastAudioState = nil
            lastDroppedFrames = 0
            return
        }
        let state: String = switch audio.state {
        case .idle: "idle"
        case .preparing: "preparing"
        case .reconnecting: "reconnecting"
        case .active: "active"
        case .interrupted: "interrupted"
        case .stopPending: "stop_pending"
        case .stopped: "stopped"
        }
        if state != lastAudioState {
            if state == "interrupted" { record(kind: .audio, code: .audioInterrupted, metric: 1) }
            if state == "active", lastAudioState != nil {
                record(kind: .audio, code: .audioRecovered, metric: 1)
            }
            lastAudioState = state
        }
        let counters = audio.counters
        let dropped = counters.captureDroppedFrames + counters.preIngestDroppedFrames
            + counters.uploadDroppedFrames + counters.playerDroppedFrames
        if dropped > lastDroppedFrames {
            record(
                kind: .audio, code: .bufferDropped,
                metric: Int(min(dropped - lastDroppedFrames, 1_000_000_000))
            )
        }
        lastDroppedFrames = dropped
    }

    private func record(kind: HostDiagnosticKind, code: HostDiagnosticCode, metric: Int) {
        guard diagnosticsEnabled, let gameID = readiness.activeGame?.gameId else { return }
        Task { [client] in
            _ = try? await client.recordDiagnostic(
                gameID: gameID, kind: kind, code: code, metricValue: metric
            )
        }
    }

    deinit { monitor?.cancel() }
}

private extension HostReadinessName {
    var title: String {
        switch self {
        case .serverCompatibility: "Host and server"
        case .deviceEnrollment: "This Mac"
        case .spotify: "Spotify"
        case .automation: "Spotify control"
        case .audioCapture: "System audio capture"
        case .relay: "Shared-audio relay"
        case .activeGame: "Active game"
        }
    }
}

struct HostReadinessView: View {
    @ObservedObject var model: HostAppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Host readiness").font(.title.bold())
            ForEach(model.readiness.checks) { check in
                HStack(alignment: .top) {
                    Image(systemName: check.state == .ready ? "checkmark.circle.fill"
                        : check.state == .checking ? "clock" : "exclamationmark.triangle.fill")
                        .foregroundStyle(check.state == .ready ? .green
                            : check.state == .checking ? .secondary : .orange)
                    VStack(alignment: .leading) {
                        Text(check.name.title).font(.headline)
                        if let recovery = check.recovery {
                            Text(recovery.message).foregroundStyle(.secondary)
                        } else { Text("Ready").foregroundStyle(.secondary) }
                    }
                    Spacer()
                }
            }
            Text(model.status).foregroundStyle(.secondary)
            HStack {
                Button("Recheck") {
                    Task { await model.refresh(requestAudioCapture: true) }
                }
                if model.readiness.checks.first(where: { $0.name == .spotify })?.state == .blocked {
                    Button("Open Spotify") { model.openSpotify() }
                }
                if model.readiness.checks.contains(where: {
                    [.allowAutomation, .allowAudioCapture, .retryAudioCapture].contains($0.recovery)
                }) { Button("Open Privacy Settings") { model.openPrivacySettings() } }
                Spacer()
                Button(model.readiness.primaryAction.kind == .createGame
                    ? "Create game" : "Resume game") {
                    Task { await model.openGame() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!model.readiness.primaryAction.enabled)
                .help(model.readiness.primaryAction.enabled ? ""
                    : model.readiness.primaryAction.blockedBy?.message ?? "Not ready")
            }
        }
        .padding(24)
        .frame(maxWidth: 760, alignment: .topLeading)
    }
}

struct HostWebView: NSViewRepresentable {
    let ticket: String
    let onFailure: @MainActor @Sendable () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFailure: onFailure) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        guard context.coordinator.loadedTicket != ticket else { return }
        context.coordinator.loadedTicket = ticket
        let endpoint = URL(
            string: "/api/host/web-tickets/exchange",
            relativeTo: HostAuthorityProtocol.productionOrigin
        )!.absoluteURL
        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["ticket": ticket])
        view.load(request)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedTicket: String?
        private var exchangeAccepted = false
        private let onFailure: @MainActor @Sendable () -> Void

        init(onFailure: @escaping @MainActor @Sendable () -> Void) {
            self.onFailure = onFailure
        }

        private func fail() {
            Task { @MainActor [onFailure] in onFailure() }
        }

        func webView(
            _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            guard let url = navigationAction.request.url else { return .cancel }
            let trusted = url.scheme == "https"
                && url.host == HostAuthorityProtocol.productionOrigin.host && url.port == nil
            if trusted { return .allow }
            if navigationAction.navigationType == .linkActivated { NSWorkspace.shared.open(url) }
            return .cancel
        }

        func webView(
            _ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse
        ) async -> WKNavigationResponsePolicy {
            guard let response = navigationResponse.response as? HTTPURLResponse else {
                return .cancel
            }
            if response.url?.path == "/api/host/web-tickets/exchange" {
                exchangeAccepted = (200..<300).contains(response.statusCode)
                if !exchangeAccepted { fail() }
                return exchangeAccepted ? .allow : .cancel
            }
            return .allow
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard exchangeAccepted,
                  webView.url?.path == "/api/host/web-tickets/exchange" else { return }
            exchangeAccepted = false
            webView.load(URLRequest(
                url: HostAuthorityProtocol.productionOrigin,
                cachePolicy: .reloadIgnoringLocalCacheData
            ))
        }

        func webView(
            _ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error
        ) { fail() }

        func webView(
            _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) { fail() }
    }
}

struct HostAdvancedView: View {
    @ObservedObject var model: HostAppModel

    var body: some View {
        Form {
            Section("Diagnostics") {
                Toggle("Retain optional diagnostics", isOn: $model.diagnosticsEnabled)
                Text("Records contain only finite event codes, counts, and server timestamps. They expire after seven days and do not contain audio, credentials, answers, paths, or device identifiers.")
                    .foregroundStyle(.secondary)
                Button("Export sanitized diagnostics…") {
                    Task { await model.exportDiagnostics() }
                }
                if !model.diagnosticStatus.isEmpty {
                    Text(model.diagnosticStatus).foregroundStyle(.secondary)
                }
            }
            Section("Shared audio") {
                Button("Reconnect shared audio") { model.reconnectAudio() }
                    .disabled(!model.readiness.sharedAudioRuntimeEnabled)
            }
        }
        .formStyle(.grouped)
    }
}

struct HostRootView: View {
    @StateObject private var model = HostAppModel()

    var body: some View {
        Group {
            if model.needsEnrollment {
                VStack {
                    HostEnrollmentView()
                    Button("Continue after enrollment") { Task { await model.start() } }
                        .buttonStyle(.borderedProminent)
                        .padding()
                }
            } else {
                TabView {
                    Group {
                        if let ticket = model.gameTicket {
                            HostWebView(ticket: ticket, onFailure: model.webSessionFailed)
                        }
                        else { HostReadinessView(model: model) }
                    }
                    .tabItem { Label("Game", systemImage: "music.note.list") }
                    HostReadinessView(model: model)
                        .tabItem { Label("Readiness", systemImage: "checklist") }
                    HostDeviceSettingsView()
                        .tabItem { Label("Settings", systemImage: "gearshape") }
                    HostAdvancedView(model: model)
                        .tabItem { Label("Advanced", systemImage: "wrench.and.screwdriver") }
                }
            }
        }
        .frame(minWidth: 920, minHeight: 680)
        .task { await model.start() }
        .onDisappear { Task { await model.shutdown() } }
    }
}

@main
struct CannaBeatsHostApp: App {
    init() {
        #if DEBUG
        UserDefaults.standard.register(defaults: [diagnosticsPreference: true])
        #else
        UserDefaults.standard.register(defaults: [diagnosticsPreference: false])
        #endif
    }

    var body: some Scene {
        WindowGroup("CannaBeats Host") { HostRootView() }
            .commands { CommandGroup(replacing: .newItem) {} }
    }
}
