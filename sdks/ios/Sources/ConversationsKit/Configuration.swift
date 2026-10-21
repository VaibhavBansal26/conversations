import Foundation

/// Everything the hosted chat needs. `baseURL` is the address of your Conversations deployment (its PUBLIC_URL).
public struct ConversationsConfiguration: Equatable {
    public var baseURL: URL
    /// The embed token (`cvt_...`) of a token with "Hosted chat" switched on. Public by design.
    public var token: String
    public var identity: VisitorIdentity?
    public var locale: String?
    public var theme: Theme
    public var primaryColor: String?
    /// Let the page pad itself with the safe-area insets (when the web view extends under the notch). Default: the view sits inside the safe area.
    public var safeArea: Bool
    /// The `device_id` from an earlier `ready` event, to continue the same anonymous visitor after storage was cleared.
    public var deviceId: String?
    public var showCloseButton: Bool
    public var debug: Bool

    public init(baseURL: URL, token: String, identity: VisitorIdentity? = nil, locale: String? = nil, theme: Theme = .auto, primaryColor: String? = nil, safeArea: Bool = false, deviceId: String? = nil, showCloseButton: Bool = false, debug: Bool = false) {
        self.baseURL = baseURL; self.token = token; self.identity = identity; self.locale = locale; self.theme = theme
        self.primaryColor = primaryColor; self.safeArea = safeArea; self.deviceId = deviceId; self.showCloseButton = showCloseButton; self.debug = debug
    }

    /// `<baseURL>/chat?token=...&bridge=ios&...` with every value percent-encoded.
    public var chatURL: URL {
        var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        var path = c.path
        while path.hasSuffix("/") { path.removeLast() }
        c.path = path + "/chat"
        var items = [URLQueryItem(name: "token", value: token), URLQueryItem(name: "bridge", value: "ios")]
        func add(_ k: String, _ v: String?) { if let v, !v.isEmpty { items.append(URLQueryItem(name: k, value: v)) } }
        add("locale", locale)
        if theme != .auto { add("theme", theme.rawValue) }
        add("primary_color", primaryColor)
        if safeArea { add("safe_area", "1") }
        add("device_id", deviceId)
        if showCloseButton { add("close_button", "1") }
        if debug { add("debug", "1") }
        if let i = identity {
            add("name", i.name); add("email", i.email); add("phone", i.phone); add("external_id", i.externalId); add("identity_hash", i.identityHash)
        }
        c.queryItems = items
        return c.url!
    }

    /// scheme://host[:port] of the deployment: the only origin the web view may navigate to.
    public var origin: String {
        let c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        return "\(c.scheme ?? "https")://\(c.host ?? "")" + (c.port.map { ":\($0)" } ?? "")
    }

    public func isSameOrigin(_ url: URL) -> Bool {
        let c = URLComponents(url: url, resolvingAgainstBaseURL: false)
        return "\(c?.scheme ?? "")://\(c?.host ?? "")" + (c?.port.map { ":\($0)" } ?? "") == origin
    }
}
