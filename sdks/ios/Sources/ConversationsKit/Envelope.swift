import Foundation

/// Protocol version spoken by this SDK (docs/MOBILE-BRIDGE.md, docs/bridge/*.schema.json).
public let bridgeProtocolVersion = 1
/// The page rejects anything larger; the SDK refuses to send or accept more.
public let bridgeMaxMessageBytes = 16_384

/// `{ "v": 1, "id": "...", "type": "...", "payload": { ... }, "reply_to": "..." }`
public struct BridgeEnvelope: Equatable, Codable {
    public var v: Int
    public var id: String
    public var type: String
    public var payload: [String: JSONValue]
    public var replyTo: String?

    public init(id: String = UUID().uuidString.lowercased(), type: String, payload: [String: JSONValue] = [:], replyTo: String? = nil) {
        self.v = bridgeProtocolVersion
        self.id = id
        self.type = type
        self.payload = payload
        self.replyTo = replyTo
    }

    enum CodingKeys: String, CodingKey { case v, id, type, payload; case replyTo = "reply_to" }

    public func encodedText() throws -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try enc.encode(self)
        guard data.count <= bridgeMaxMessageBytes, let s = String(data: data, encoding: .utf8) else { throw BridgeError.tooLarge }
        return s
    }
}

public enum BridgeError: Error, Equatable {
    case tooLarge
    case notJSON
    case notEnvelope
    /// A different protocol version: ignored, never answered (so a newer page can talk to an older SDK).
    case unsupportedVersion(Int?)
    case notReady
    case failed(code: String, message: String)
    case timedOut
}

public enum EnvelopeDecoding {
    /// Parse text sent by the page. Never crashes on hostile input.
    public static func decode(_ text: String) -> Result<BridgeEnvelope, BridgeError> {
        guard text.utf8.count <= bridgeMaxMessageBytes else { return .failure(.tooLarge) }
        guard let data = text.data(using: .utf8), let any = try? JSONSerialization.jsonObject(with: data), let obj = any as? [String: Any] else { return .failure(.notJSON) }
        guard obj["v"] as? Int == bridgeProtocolVersion else { return .failure(.unsupportedVersion(obj["v"] as? Int)) }
        guard let id = obj["id"] as? String, (1...64).contains(id.count), obj["type"] is String, obj["payload"] is [String: Any] else { return .failure(.notEnvelope) }
        guard let env = try? JSONDecoder().decode(BridgeEnvelope.self, from: data) else { return .failure(.notEnvelope) }
        return .success(env)
    }
}

/// The JavaScript that delivers `text` to the page: `ConversationsBridge.receive("<json text as a JS string>")`. The text is escaped as a JSON string,
/// so quotes, newlines, U+2028 and `</script>` inside it cannot break out of the literal.
public func bridgeReceiveScript(for text: String) -> String {
    var lit = "\""
    for u in text.unicodeScalars {
        switch u {
        case "\"": lit += "\\\""
        case "\\": lit += "\\\\"
        case "\n": lit += "\\n"
        case "\r": lit += "\\r"
        case "\t": lit += "\\t"
        case "\u{2028}": lit += "\\u2028"
        case "\u{2029}": lit += "\\u2029"
        case "<": lit += "\\u003C"
        default:
            if u.value < 0x20 { lit += String(format: "\\u%04X", u.value) } else { lit.unicodeScalars.append(u) }
        }
    }
    lit += "\""
    return "window.ConversationsBridge && window.ConversationsBridge.receive(\(lit));"
}
