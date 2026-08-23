import AppKit
import SwiftUI

@MainActor
public final class HostEnrollmentModel: ObservableObject {
    @Published public var enrollmentCode = ""
    @Published public var deviceLabel = Host.current().localizedName ?? "This Mac"
    @Published public private(set) var status = "Paste a 24-hour enrollment code."
    @Published public private(set) var isWorking = false
    @Published public private(set) var enrolled = false

    private let client: HostAuthorityClient

    public init(client: HostAuthorityClient = HostAuthorityClient()) {
        self.client = client
    }

    public func enroll() async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await client.enroll(code: enrollmentCode, label: deviceLabel)
            _ = try await client.establishApplicationSession()
            enrollmentCode = ""
            enrolled = true
            status = "This Mac is authorized."
        } catch let error as HostAuthorityClientError {
            status = Self.message(error)
        } catch {
            status = "Enrollment could not be completed."
        }
    }

    private static func message(_ error: HostAuthorityClientError) -> String {
        switch error {
        case .server("expired"): "That enrollment code expired. Create a new one."
        case .server("already_used"): "That enrollment code was already used."
        case .server("capacity_reached"): "The authorized-device limit has been reached."
        case .server, .invalidResponse: "Enrollment was rejected by the CannaBeats server."
        case .transport: "The CannaBeats server could not be reached. Try again."
        case .noApplicationSession: "This Mac needs to prove its device key again."
        case .pendingEnrollmentExists: "Finish the pending enrollment before using another code."
        case .pendingProofExists: "Finish the pending device proof before changing local authority."
        }
    }

    public func resumePendingEnrollment() async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            guard try await client.resumePendingEnrollment() != nil else { return }
            _ = try await client.establishApplicationSession()
            enrolled = true
            status = "This Mac is authorized."
        } catch let error as HostAuthorityClientError {
            status = Self.message(error)
        } catch {
            status = "Pending enrollment could not be completed."
        }
    }
}

public struct HostEnrollmentView: View {
    @StateObject private var model: HostEnrollmentModel

    public init(model: @autoclosure @escaping () -> HostEnrollmentModel = HostEnrollmentModel()) {
        _model = StateObject(wrappedValue: model())
    }

    public var body: some View {
        Form {
            TextField("Mac name", text: $model.deviceLabel)
            SecureField("Enrollment code", text: $model.enrollmentCode)
            Button(model.isWorking ? "Enrolling…" : "Enroll this Mac") {
                Task { await model.enroll() }
            }
            .disabled(model.isWorking || model.enrollmentCode.isEmpty || model.deviceLabel.isEmpty)
            Text(model.status).foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
        .task { await model.resumePendingEnrollment() }
    }
}

@MainActor
public final class HostDeviceSettingsModel: ObservableObject {
    @Published public private(set) var devices: [HostDevice] = []
    @Published public private(set) var enrollment: HostEnrollment?
    @Published public private(set) var status = ""
    @Published public var confirmsLocalReset = false

    private let client: HostAuthorityClient

    public init(client: HostAuthorityClient = HostAuthorityClient()) {
        self.client = client
    }

    public func reload() async {
        do {
            devices = try await client.devices()
            status = ""
        } catch {
            status = "The Host device list is unavailable."
        }
    }

    public func revoke(_ device: HostDevice) async {
        do {
            try await client.revoke(deviceID: device.deviceId)
            await reload()
        } catch {
            status = "That device could not be revoked."
        }
    }

    public func issueEnrollment() async {
        do {
            enrollment = try await client.issueEnrollment()
            status = "This code expires in 24 hours."
        } catch {
            status = "A new enrollment code could not be created."
        }
    }

    public func copyEnrollmentCode() {
        guard let enrollment else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(enrollment.code, forType: .string)
        status = "Enrollment code copied."
    }

    public func resetLocalAuthority() {
        do {
            try HostCredentials.clearLocalAuthority()
            devices = []
            status = "Local Host authority was erased. Enroll this Mac again."
        } catch {
            status = "Local Host authority could not be erased."
        }
    }
}

public struct HostDeviceSettingsView: View {
    @StateObject private var model: HostDeviceSettingsModel
    @State private var pendingRevocation: HostDevice?

    public init(
        model: @autoclosure @escaping () -> HostDeviceSettingsModel = HostDeviceSettingsModel()
    ) {
        _model = StateObject(wrappedValue: model())
    }

    public var body: some View {
        Form {
            Section("Add a Mac") {
                Button("Create 24-hour enrollment code") {
                    Task { await model.issueEnrollment() }
                }
                if let enrollment = model.enrollment {
                    Text(enrollment.code).font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                    Button("Copy code") { model.copyEnrollmentCode() }
                }
            }
            Section("Authorized Macs") {
                ForEach(model.devices, id: \.deviceId) { device in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(device.label)
                            Text(device.deviceId.uuidString.lowercased())
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if device.revokedAt == nil {
                            Button("Revoke", role: .destructive) {
                                pendingRevocation = device
                            }
                        } else {
                            Text("Revoked").foregroundStyle(.secondary)
                        }
                    }
                }
            }
            Section {
                Button("Erase authority from this Mac…", role: .destructive) {
                    model.confirmsLocalReset = true
                }
            } footer: {
                Text("This permanently deletes this Mac’s private key. Revoke its server device first whenever another Host is available.")
            }
            if !model.status.isEmpty { Text(model.status).foregroundStyle(.secondary) }
        }
        .formStyle(.grouped)
        .task { await model.reload() }
        .alert("Erase local Host authority?", isPresented: $model.confirmsLocalReset) {
            Button("Cancel", role: .cancel) {}
            Button("Erase", role: .destructive) { model.resetLocalAuthority() }
        } message: {
            Text("This cannot be undone. This Mac will need a new enrollment code before it can host again.")
        }
        .alert(item: $pendingRevocation) { device in
            Alert(
                title: Text("Revoke \(device.label)?"),
                message: Text("This immediately ends that Mac’s authority. If it owns an unfinished game, that game is abandoned so another Host can begin a new one."),
                primaryButton: .cancel(),
                secondaryButton: .destructive(Text("Revoke")) {
                    Task { await model.revoke(device) }
                }
            )
        }
    }
}
