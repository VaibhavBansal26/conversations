import Foundation

/// Who the visitor is. With `identityHash` (computed by YOUR backend, never in the app) the server verifies the person without a code.
public struct VisitorIdentity: Equatable {
    public var externalId: String?
    public var email: String?
    public var name: String?
    public var phone: String?
    public var identityHash: String?
    public init(externalId: String? = nil, email: String? = nil, name: String? = nil, phone: String? = nil, identityHash: String? = nil) {
        self.externalId = externalId; self.email = email; self.name = name; self.phone = phone; self.identityHash = identityHash
    }
    var payload: [String: JSONValue] {
        var p: [String: JSONValue] = [:]
        if let v = externalId { p["external_id"] = .string(v) }
        if let v = email { p["email"] = .string(v) }
        if let v = name { p["name"] = .string(v) }
        if let v = phone { p["phone"] = .string(v) }
        if let v = identityHash { p["identity_hash"] = .string(v) }
        return p
    }
}

public enum Theme: String { case light, dark, auto }

/// Commands the app sends to the page.
public enum BridgeCommand: Equatable {
    case identify(VisitorIdentity)
    case setLanguage(locale: String, strings: [String: String] = [:])
    case setTheme(Theme?, primaryColor: String? = nil, textColor: String? = nil)
    case setCustomAttributes([String: JSONValue])
    case open
    case close
    case back
    case reset
    case sendMessage(text: String, send: Bool = false)
    case restoreSession(deviceId: String)

    public var type: String {
        switch self {
        case .identify: return "identify"
        case .setLanguage: return "setLanguage"
        case .setTheme: return "setTheme"
        case .setCustomAttributes: return "setCustomAttributes"
        case .open: return "open"
        case .close: return "close"
        case .back: return "back"
        case .reset: return "reset"
        case .sendMessage: return "sendMessage"
        case .restoreSession: return "restoreSession"
        }
    }

    public var payload: [String: JSONValue] {
        switch self {
        case .identify(let i): return i.payload
        case .setLanguage(let locale, let strings):
            var p: [String: JSONValue] = ["locale": .string(locale)]
            if !strings.isEmpty { p["strings"] = .object(strings.mapValues { .string($0) }) }
            return p
        case .setTheme(let theme, let primary, let text):
            var p: [String: JSONValue] = [:]
            if let theme { p["theme"] = .string(theme.rawValue) }
            if let primary { p["primary_color"] = .string(primary) }
            if let text { p["text_color"] = .string(text) }
            return p
        case .setCustomAttributes(let a): return ["attributes": .object(a)]
        case .open, .close, .back, .reset: return [:]
        case .sendMessage(let text, let send): return ["text": .string(text), "send": .bool(send)]
        case .restoreSession(let id): return ["device_id": .string(id)]
        }
    }

    public func envelope(id: String = UUID().uuidString.lowercased()) -> BridgeEnvelope { BridgeEnvelope(id: id, type: type, payload: payload) }
}

public struct ReadyInfo: Equatable {
    public var pageVersion: String
    /// Not a credential. Store it and pass it as `device_id` next launch to continue the same anonymous visitor.
    public var deviceId: String
    public var locale: String
    public var theme: String
    public var features: [String]
    public var unreadCount: Int
}

public struct ReceivedMessage: Equatable {
    public var messageId: String
    public var senderType: String
    public var preview: String
    public var hasAttachments: Bool
    public var inForeground: Bool
}

public enum LinkSource: String { case message, attachment, payment }
public enum AuthReason: String { case identityInvalid = "identity_invalid", verificationRequired = "verification_required", sessionExpired = "session_expired", conflict }

/// Events the page sends to the app.
public enum BridgeEvent: Equatable {
    case ready(ReadyInfo)
    case unreadCountChanged(Int)
    case messageReceived(ReceivedMessage)
    case conversationStarted(roomId: String)
    case conversationClosed(roomId: String)
    case linkClicked(url: URL, source: LinkSource)
    case attachmentRequested(kinds: [String])
    case authRequired(AuthReason)
    case error(code: String, message: String, fatal: Bool)
    case closeRequested
    /// A type added by a newer page within protocol v1: ignored by default, surfaced for logging.
    case unknown(type: String)

    /// Decode an event envelope. Returns nil for `ack` (handled by the endpoint) and for malformed payloads (never crashes).
    static func decode(_ env: BridgeEnvelope) -> BridgeEvent? {
        let p = env.payload
        switch env.type {
        case "ack": return nil
        case "ready":
            guard let pv = p["page_version"]?.stringValue, let dev = p["device_id"]?.stringValue, let loc = p["locale"]?.stringValue, let theme = p["theme"]?.stringValue, let unread = p["unread_count"]?.intValue else { return nil }
            return .ready(ReadyInfo(pageVersion: pv, deviceId: dev, locale: loc, theme: theme, features: (p["features"]?.arrayValue ?? []).compactMap { $0.stringValue }, unreadCount: unread))
        case "unread_count_changed":
            guard let c = p["count"]?.intValue, c >= 0 else { return nil }
            return .unreadCountChanged(c)
        case "message_received":
            guard let id = p["message_id"]?.stringValue, let st = p["sender_type"]?.stringValue, let pr = p["preview"]?.stringValue, let att = p["has_attachments"]?.boolValue, let fg = p["in_foreground"]?.boolValue else { return nil }
            return .messageReceived(ReceivedMessage(messageId: id, senderType: st, preview: pr, hasAttachments: att, inForeground: fg))
        case "conversation_started": return p["room_id"]?.stringValue.map { .conversationStarted(roomId: $0) }
        case "conversation_closed": return p["room_id"]?.stringValue.map { .conversationClosed(roomId: $0) }
        case "link_clicked":
            guard let s = p["url"]?.stringValue, let url = LinkPolicy.validated(s), let src = LinkSource(rawValue: p["source"]?.stringValue ?? "") else { return nil }
            return .linkClicked(url: url, source: src)
        case "attachment_requested": return .attachmentRequested(kinds: (p["kinds"]?.arrayValue ?? []).compactMap { $0.stringValue })
        case "auth_required": return AuthReason(rawValue: p["reason"]?.stringValue ?? "").map { .authRequired($0) }
        case "error":
            guard let code = p["code"]?.stringValue, let msg = p["message"]?.stringValue, let fatal = p["fatal"]?.boolValue else { return nil }
            return .error(code: code, message: msg, fatal: fatal)
        case "close_requested": return .closeRequested
        default: return .unknown(type: env.type)
        }
    }
}

/// The page's answer to a command.
public struct BridgeAck: Equatable {
    public var ok: Bool
    public var handled: Bool?
    public var result: [String: JSONValue]
    public var errorCode: String?
    public var errorMessage: String?
}

/// Only https, mailto and tel URLs may be opened from chat content (the page validates too; this is the second check).
public enum LinkPolicy {
    public static func validated(_ s: String) -> URL? {
        guard s.count <= 2048, let url = URL(string: s), let scheme = url.scheme?.lowercased() else { return nil }
        guard ["https", "mailto", "tel"].contains(scheme) else { return nil }
        if scheme == "https" && (url.host ?? "").isEmpty { return nil }
        return url
    }
}
