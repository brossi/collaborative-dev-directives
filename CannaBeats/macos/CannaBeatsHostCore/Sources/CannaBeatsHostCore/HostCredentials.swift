import Foundation
import Security

public enum HostCredentials {
    private static let service = "social.cannabeats.host"
    private static let deviceAccount = "host-device-id"
    private static let sessionAccount = "host-application-session"
    private static let pendingEnrollmentAccount = "host-pending-enrollment"
    private static let pendingProofAccount = "host-pending-proof"
    private static let pendingAudioEndAccount = "host-pending-audio-end"

    public static func deviceID() throws -> UUID {
        if let data = try load(account: deviceAccount),
           let value = String(data: data, encoding: .utf8),
           let identifier = UUID(uuidString: value) {
            return identifier
        }
        let identifier = UUID()
        try save(Data(identifier.uuidString.lowercased().utf8), account: deviceAccount)
        return identifier
    }

    public static func applicationSession() throws -> String? {
        guard let data = try load(account: sessionAccount),
              let value = String(data: data, encoding: .utf8), !value.isEmpty else { return nil }
        return value
    }

    public static func saveApplicationSession(_ token: String) throws {
        try save(Data(token.utf8), account: sessionAccount)
    }

    public static func clearLocalAuthority() throws {
        try DeviceSigningKey.deleteLocalIdentity()
        try delete(account: deviceAccount)
        try delete(account: sessionAccount)
        try delete(account: pendingEnrollmentAccount)
        try delete(account: pendingProofAccount)
        try delete(account: pendingAudioEndAccount)
    }

    public static func pendingEnrollment() throws -> HostPendingEnrollment? {
        guard let data = try load(account: pendingEnrollmentAccount) else { return nil }
        guard let value = try? JSONDecoder().decode(HostPendingEnrollment.self, from: data) else {
            throw DeviceKeyError.invalidStoredKey
        }
        return value
    }

    public static func savePendingEnrollment(_ intent: HostPendingEnrollment) throws {
        try save(JSONEncoder().encode(intent), account: pendingEnrollmentAccount)
    }

    public static func clearPendingEnrollment() throws {
        try delete(account: pendingEnrollmentAccount)
    }

    public static func pendingProof() throws -> HostPendingProof? {
        guard let data = try load(account: pendingProofAccount) else { return nil }
        guard let value = try? JSONDecoder().decode(HostPendingProof.self, from: data) else {
            throw DeviceKeyError.invalidStoredKey
        }
        return value
    }

    public static func savePendingProof(_ intent: HostPendingProof) throws {
        try save(JSONEncoder().encode(intent), account: pendingProofAccount)
    }

    public static func clearPendingProof() throws {
        try delete(account: pendingProofAccount)
    }

    public static func pendingAudioEnd() throws -> HostPendingAudioEnd? {
        guard let data = try load(account: pendingAudioEndAccount) else { return nil }
        guard let value = try? JSONDecoder().decode(HostPendingAudioEnd.self, from: data) else {
            throw DeviceKeyError.invalidStoredKey
        }
        return value
    }

    public static func savePendingAudioEnd(_ intent: HostPendingAudioEnd) throws {
        try save(JSONEncoder().encode(intent), account: pendingAudioEndAccount)
    }

    public static func clearPendingAudioEnd() throws {
        try delete(account: pendingAudioEndAccount)
    }

    private static func load(account: String) throws -> Data? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw DeviceKeyError.keychain(status)
        }
        return data
    }

    private static func save(_ data: Data, account: String) throws {
        let query = baseQuery(account: account)
        let update = [kSecValueData as String: data]
        let updated = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw DeviceKeyError.keychain(updated) }
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(insert as CFDictionary, nil)
        guard status == errSecSuccess else { throw DeviceKeyError.keychain(status) }
    }

    private static func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw DeviceKeyError.keychain(status)
        }
    }

    private static func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

public struct HostPendingEnrollment: Codable, Equatable, Sendable {
    let deviceId: String
    let enrollmentCode: String
    let label: String
    let publicKey: String
    let requestId: String
}

public struct HostPendingProof: Codable, Equatable, Sendable {
    let challenge: String
    let challengeRequestId: String
    let deviceId: String
    let proofRequestId: String
    let sessionToken: String
    let signature: String
}

public struct HostPendingAudioEnd: Codable, Equatable, Sendable {
    public let gameID: UUID
    public let audioSessionID: UUID
    public let requestID: UUID
    public let mayBeAbsent: Bool

    public init(
        gameID: UUID, audioSessionID: UUID, requestID: UUID, mayBeAbsent: Bool
    ) {
        self.gameID = gameID
        self.audioSessionID = audioSessionID
        self.requestID = requestID
        self.mayBeAbsent = mayBeAbsent
    }
}
