import Foundation
import Security

public enum HostAuthorityProtocolError: Error, Equatable {
    case randomnessUnavailable
    case invalidOrigin
}

public enum HostAuthorityProtocol {
    public static let productionOrigin = URL(string: "https://play.cannabeats.social")!

    public static func randomBearer(byteCount: Int = 24) throws -> String {
        precondition(byteCount >= 16)
        var bytes = [UInt8](repeating: 0, count: byteCount)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw HostAuthorityProtocolError.randomnessUnavailable
        }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func proofData(
        challenge: String,
        deviceID: UUID,
        origin: URL = productionOrigin
    ) throws -> Data {
        guard origin.scheme == "https", origin.host != nil,
              origin.path.isEmpty, origin.query == nil, origin.fragment == nil else {
            throw HostAuthorityProtocolError.invalidOrigin
        }
        let envelope: [String: Any] = [
            "audience": "cannabeats-host-proof",
            "challenge": challenge,
            "deviceId": deviceID.uuidString.lowercased(),
            "origin": origin.absoluteString,
            "version": 1,
        ]
        return try JSONSerialization.data(
            withJSONObject: envelope,
            options: [.sortedKeys, .withoutEscapingSlashes]
        )
    }
}
