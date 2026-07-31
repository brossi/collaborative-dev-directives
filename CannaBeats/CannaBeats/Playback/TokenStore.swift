import Foundation
import Security

/// Keychain-backed store for the App Remote access token, so a restart during
/// game night reconnects without bouncing through the Spotify app.
///
/// The token is a credential, so it lives in the Keychain rather than
/// UserDefaults, and is marked `ThisDeviceOnly` — it should not ride a backup
/// onto another phone.
///
/// The App Remote auth callback returns ONLY the token: there is no expiry in
/// `SPTAppRemoteAccessTokenKey`/`SPTAppRemoteErrorKey`/`ErrorDescriptionKey`.
/// So `maxAge` below is a heuristic to skip an attempt that would obviously
/// fail — never a correctness guarantee. Correctness comes from the fallback:
/// a plain connect that fails drops the token and the next attempt authorizes,
/// which is exactly what the app did before any of this was stored.
enum TokenStore {
    private static let service = "social.cannabeats.app.appremote"
    private static let account = "access-token"

    /// Conservative ceiling on reuse. Spotify does not publish this through
    /// the App Remote callback, so guessing high would only produce failed
    /// connects; guessing low costs one avoidable bounce. Erring low.
    private static let maxAge: TimeInterval = 50 * 60

    struct Stored {
        let token: String
        let acquired: Date
        var isFresh: Bool { Date().timeIntervalSince(acquired) < maxAge }
    }

    static func save(token: String) {
        // Timestamp travels with the token: a token with no acquisition time
        // could not be aged out at all.
        let payload = ["token": token, "acquired": ISO8601DateFormatter().string(from: Date())]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status != errSecSuccess {
            print("[TokenStore] save failed: OSStatus \(status)")
        }
    }

    static func load() -> Stored? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let token = payload["token"], !token.isEmpty,
              let acquiredString = payload["acquired"],
              let acquired = ISO8601DateFormatter().date(from: acquiredString)
        else { return nil }
        return Stored(token: token, acquired: acquired)
    }

    static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
