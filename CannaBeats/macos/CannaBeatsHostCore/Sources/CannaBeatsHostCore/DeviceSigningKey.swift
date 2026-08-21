import CryptoKit
import Foundation
import Security

public enum DeviceKeyError: LocalizedError {
    case keychain(OSStatus)
    case invalidStoredKey

    public var errorDescription: String? {
        switch self {
        case .keychain(let status):
            SecCopyErrorMessageString(status, nil) as String? ?? "Keychain operation failed."
        case .invalidStoredKey:
            "The stored CannaBeats device key is invalid."
        }
    }
}

public enum DeviceSigningKey {
    case secureEnclave(SecureEnclave.P256.Signing.PrivateKey)
    case keychain(P256.Signing.PrivateKey)

    private static let service = "social.cannabeats.host"
    private static let account = "host-device-signing-key"
    private static let secureEnclaveMarker: UInt8 = 1
    private static let softwareMarker: UInt8 = 2

    public var publicKeyDER: Data {
        switch self {
        case .secureEnclave(let key): key.publicKey.derRepresentation
        case .keychain(let key): key.publicKey.derRepresentation
        }
    }

    public var protectionDescription: String {
        switch self {
        case .secureEnclave: "Secure Enclave signing key"
        case .keychain: "This-device-only Keychain signing key"
        }
    }

    public func signature(for data: Data) throws -> Data {
        switch self {
        case .secureEnclave(let key): try key.signature(for: data).derRepresentation
        case .keychain(let key): try key.signature(for: data).derRepresentation
        }
    }

    public static func load() throws -> DeviceSigningKey? {
        guard let stored = try loadData(), let marker = stored.first else { return nil }
        let representation = stored.dropFirst()
        switch marker {
        case secureEnclaveMarker:
            return .secureEnclave(try SecureEnclave.P256.Signing.PrivateKey(
                dataRepresentation: Data(representation)
            ))
        case softwareMarker:
            return .keychain(try P256.Signing.PrivateKey(rawRepresentation: representation))
        default:
            throw DeviceKeyError.invalidStoredKey
        }
    }

    public static func loadOrCreate() throws -> DeviceSigningKey {
        if let stored = try load() { return stored }
        if SecureEnclave.isAvailable,
           let key = try? SecureEnclave.P256.Signing.PrivateKey() {
            try saveData(Data([secureEnclaveMarker]) + key.dataRepresentation)
            return .secureEnclave(key)
        }
        let key = P256.Signing.PrivateKey()
        try saveData(Data([softwareMarker]) + key.rawRepresentation)
        return .keychain(key)
    }

    public static func deleteLocalIdentity() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw DeviceKeyError.keychain(status)
        }
    }

    private static func loadData() throws -> Data? {
        var query = baseQuery()
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

    private static func saveData(_ data: Data) throws {
        var query = baseQuery()
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw DeviceKeyError.keychain(status) }
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
