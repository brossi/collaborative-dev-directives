import SwiftUI

@main
struct CannaBeatsHostPoCApp: App {
    @StateObject private var model = HostAgentModel()

    var body: some Scene {
        WindowGroup {
            HostAgentView(model: model)
                .frame(minWidth: 680, minHeight: 720)
        }
        .windowResizability(.contentMinSize)
    }
}

private struct HostAgentView: View {
    @ObservedObject var model: HostAgentModel
    @State private var confirmReset = false
    @State private var showManualAudioControls = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header
                serverSection
                authorizationSection
                statusSection
                audioSection
            }
            .padding(28)
        }
        .background(
            LinearGradient(
                colors: [Color(red: 0.05, green: 0.11, blue: 0.07), Color(red: 0.08, green: 0.17, blue: 0.11)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .ignoresSafeArea()
        )
        .preferredColorScheme(.dark)
        .confirmationDialog(
            "Remove this Mac’s local host identity?",
            isPresented: $confirmReset,
            titleVisibility: .visible
        ) {
            Button("Remove local identity", role: .destructive) {
                model.resetLocalAuthorization()
            }
        } message: {
            Text("This deletes the signing key from Keychain. You should also revoke the old application from your CannaBeats account.")
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("PRIVATE HOST PROOF OF CONCEPT")
                .font(.caption.bold())
                .tracking(1.7)
                .foregroundStyle(Color(red: 0.51, green: 0.86, blue: 0.62))
            Text("CannaBeats Host")
                .font(.system(size: 36, weight: .bold, design: .rounded))
            Text("Authorize this Mac with your existing CannaBeats passkey. Spotify credentials remain in the PWA; this application receives only a device-scoped host identity.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var serverSection: some View {
        GroupBox("Connection") {
            VStack(alignment: .leading, spacing: 12) {
                TextField("CannaBeats server", text: $model.serverOrigin)
                    .textFieldStyle(.roundedBorder)
                    .disabled(model.isBusy || model.isPaired)
                TextField("Application name", text: $model.deviceName)
                    .textFieldStyle(.roundedBorder)
                    .disabled(model.isBusy || model.isPaired)
                Label(model.keyProtection, systemImage: "key.horizontal")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(6)
        }
    }

    private var authorizationSection: some View {
        GroupBox("Host authorization") {
            VStack(alignment: .leading, spacing: 14) {
                if model.isPaired {
                    Label("Paired with \(model.pairedUser.isEmpty ? "a CannaBeats host" : model.pairedUser)", systemImage: "checkmark.shield.fill")
                        .foregroundStyle(Color(red: 0.51, green: 0.86, blue: 0.62))
                    if let agentID = model.agentID {
                        Text("Agent \(agentID)")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    HStack {
                        Button("Prove authorization") {
                            Task { await model.proveAuthorization() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.isBusy)
                        Button("Remove from this Mac", role: .destructive) {
                            confirmReset = true
                        }
                        .buttonStyle(.bordered)
                        .disabled(model.isBusy)
                    }
                } else if !model.pairingCode.isEmpty {
                    Text(model.pairingCode)
                        .font(.system(size: 34, weight: .bold, design: .monospaced))
                        .textSelection(.enabled)
                    Text("Approve this one-time code in the browser using your CannaBeats passkey. The application checks for approval automatically.")
                        .foregroundStyle(.secondary)
                    HStack {
                        Button("Open authorization page") {
                            model.openAuthorizationPage()
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(!model.canOpenAuthorization)
                        Button("Check now") {
                            Task { await model.checkPairingOnce() }
                        }
                        .buttonStyle(.bordered)
                    }
                } else {
                    Button("Pair this Mac") {
                        Task { await model.startPairing() }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(model.isBusy || model.deviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(6)
        }
    }

    private var statusSection: some View {
        GroupBox("Status") {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    if model.isBusy { ProgressView().controlSize(.small) }
                    Text(model.status)
                        .foregroundStyle(model.errorMessage.isEmpty ? .primary : .secondary)
                }
                if !model.errorMessage.isEmpty {
                    Text(model.errorMessage)
                        .foregroundStyle(Color(red: 1.0, green: 0.62, blue: 0.57))
                        .textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(6)
        }
    }

    private var audioSection: some View {
        GroupBox("Shared audio proof") {
            VStack(alignment: .leading, spacing: 12) {
                Label("Start the game from here", systemImage: "waveform")
                    .font(.headline)
                Text("Prepare the relay first, then let this app open CannaBeats. It watches for the PWA’s Spotify audio and attaches automatically. Once attached, the source’s direct output is muted and this Mac listens through the same relay stream as the players.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack {
                    if model.isRelaying {
                        Button("Stop shared audio", role: .destructive) {
                            model.stopSharedAudio()
                        }
                        .buttonStyle(.borderedProminent)
                    } else if model.isAwaitingAudioProcess {
                        ProgressView()
                            .controlSize(.small)
                        Button("Open CannaBeats again") { model.openCannaBeats() }
                            .buttonStyle(.borderedProminent)
                        Button("Cancel") { model.cancelAudioPreparation() }
                            .buttonStyle(.bordered)
                    } else {
                        Button("Prepare shared audio & open CannaBeats") {
                            Task { await model.prepareAndOpenCannaBeats() }
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(model.isBusy || !model.isPaired)
                    }
                    if model.isBusy { ProgressView().controlSize(.small) }
                }

                if !model.isPaired {
                    Text("Authorize this Mac above before preparing shared audio.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Text(model.audioStatus)
                    .foregroundStyle(model.errorMessage.isEmpty ? .primary : .secondary)
                Text(model.audioMetrics)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)

                DisclosureGroup(
                    "Troubleshooting: choose an audio process manually",
                    isExpanded: $showManualAudioControls
                ) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Picker("Audio process", selection: $model.selectedAudioProcessID) {
                                if model.audioProcesses.isEmpty {
                                    Text("No active audio process").tag(UInt32(0))
                                }
                                ForEach(model.audioProcesses, id: \.objectID) { process in
                                    Text("\(process.displayName) — PID \(process.processIdentifier)")
                                        .tag(process.objectID)
                                }
                            }
                            .disabled(model.isBusy || model.isRelaying)
                            Button("Refresh") { model.refreshAudioProcesses() }
                                .disabled(model.isBusy || model.isRelaying)
                        }

                        if let process = model.selectedAudioProcess,
                           !process.bundleIdentifier.isEmpty {
                            Text(process.bundleIdentifier)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }

                        Button("Start with selected process") {
                            Task { await model.startSharedAudio() }
                        }
                        .disabled(model.isBusy || model.isRelaying || !model.isPaired || model.selectedAudioProcess == nil)
                    }
                    .padding(.top, 8)
                }
            }
            .padding(6)
        }
    }
}
