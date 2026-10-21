#if canImport(UIKit) && canImport(WebKit)
import UIKit
import WebKit

/// Receives events and makes the decisions only the app can make. All methods are optional (default implementations do the safe thing).
public protocol ConversationsChatDelegate: AnyObject {
    /// Every bridge event, on the main queue.
    func chat(_ chat: ConversationsChatViewController, didReceive event: BridgeEvent)
    /// A visitor tapped a link (already validated: https, mailto or tel). Return true if you opened it. Default: `UIApplication.open`.
    func chat(_ chat: ConversationsChatViewController, shouldOpen url: URL, source: LinkSource) -> Bool
    /// The unread count changed (also available as `chat.unreadCount`).
    func chat(_ chat: ConversationsChatViewController, unreadCountDidChange count: Int)
    /// The page reported a device id. Persist it (it is not a credential) and pass it back in `ConversationsConfiguration.deviceId` next launch.
    func chat(_ chat: ConversationsChatViewController, didReceiveDeviceId deviceId: String)
    /// The chat cannot run (bad token, hosted chat switched off, network): show your own screen. Default: nothing.
    func chat(_ chat: ConversationsChatViewController, didFailWith code: String, message: String)
    /// The header close button was tapped (`showCloseButton`).
    func chatDidRequestClose(_ chat: ConversationsChatViewController)
}

public extension ConversationsChatDelegate {
    func chat(_ chat: ConversationsChatViewController, didReceive event: BridgeEvent) {}
    func chat(_ chat: ConversationsChatViewController, shouldOpen url: URL, source: LinkSource) -> Bool {
        UIApplication.shared.open(url)
        return true
    }
    func chat(_ chat: ConversationsChatViewController, unreadCountDidChange count: Int) {}
    func chat(_ chat: ConversationsChatViewController, didReceiveDeviceId deviceId: String) {}
    func chat(_ chat: ConversationsChatViewController, didFailWith code: String, message: String) {}
    func chatDidRequestClose(_ chat: ConversationsChatViewController) {}
}

/// Forwards script messages without keeping the view controller alive: `WKUserContentController` retains its handlers strongly, so handing it the
/// controller itself would make a cycle (controller -> web view -> configuration -> content controller -> controller) and the chat would never deallocate.
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

/// The hosted chat in a `WKWebView`. Create it with a configuration and present it like any view controller.
///
/// Camera and photo library: the page uses a file input, which iOS handles itself, but the app's Info.plist must contain
/// `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription` (see sdks/ios/README.md).
public final class ConversationsChatViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    public private(set) var configuration: ConversationsConfiguration
    public weak var delegate: ConversationsChatDelegate?
    public var unreadCount: Int { endpoint.unreadCount }

    private(set) var webView: WKWebView!
    private lazy var endpoint: BridgeEndpoint = {
        let e = BridgeEndpoint { [weak self] text in
            DispatchQueue.main.async { self?.webView?.evaluateJavaScript(bridgeReceiveScript(for: text), completionHandler: nil) }
        }
        e.linkHandler = { [weak self] url, source in
            guard let self else { return false }
            return self.delegate?.chat(self, shouldOpen: url, source: source) ?? { UIApplication.shared.open(url); return true }()
        }
        e.onEvent = { [weak self] event in self?.handle(event) }
        return e
    }()
    private var timer: Timer?
    private static let handlerName = "conversations"

    public init(configuration: ConversationsConfiguration) {
        self.configuration = configuration
        super.init(nibName: nil, bundle: nil)
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("use init(configuration:)") }

    deinit {
        timer?.invalidate()
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: Self.handlerName)
    }

    public override func loadView() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(WeakScriptMessageHandler(self), name: Self.handlerName)
        config.allowsInlineMediaPlayback = true
        // each launch starts from the persistent store so the hosted chat keeps its session; nothing is shared with other web views of the app
        config.websiteDataStore = .default()
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.scrollView.bounces = false
        wv.isOpaque = false
        wv.backgroundColor = .clear
        wv.allowsBackForwardNavigationGestures = false
        wv.customUserAgent = nil
        #if DEBUG
        if #available(iOS 16.4, *) { wv.isInspectable = configuration.debug }
        #endif
        webView = wv
        view = UIView()
        view.backgroundColor = .systemBackground
        view.addSubview(wv)
        wv.translatesAutoresizingMaskIntoConstraints = false
        // inside the safe area unless the page pads itself (`safeArea`)
        let guide = configuration.safeArea ? nil : view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: guide?.topAnchor ?? view.topAnchor),
            wv.bottomAnchor.constraint(equalTo: guide?.bottomAnchor ?? view.bottomAnchor),
            wv.leadingAnchor.constraint(equalTo: guide?.leadingAnchor ?? view.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: guide?.trailingAnchor ?? view.trailingAnchor),
        ])
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        load()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.endpoint.expirePending(olderThan: 10) }
    }

    public override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        // dark mode: with `.auto` the page follows prefers-color-scheme itself, which WKWebView mirrors; nothing to do. Forced themes are in the URL.
    }

    private func load() {
        endpoint.reload()
        webView.load(URLRequest(url: configuration.chatURL))
    }

    /// Reload the chat page (for example after the user signs in or out and you changed the configuration).
    public func reload(with configuration: ConversationsConfiguration? = nil) {
        if let configuration { self.configuration = configuration }
        load()
    }

    // MARK: commands

    /// Send a command to the page. Commands sent before the page is ready are queued and flushed on `ready`.
    public func send(_ command: BridgeCommand, completion: @escaping (Result<BridgeAck, BridgeError>) -> Void = { _ in }) {
        endpoint.send(command, completion: completion)
    }
    public func identify(_ identity: VisitorIdentity) { send(.identify(identity)) }
    /// Log the visitor out of the chat (ends the server session, forgets local data).
    public func reset() { send(.reset) }
    /// Call from your navigation's back handling: `handled == false` means leave the screen.
    public func handleBack(completion: @escaping (Bool) -> Void) {
        send(.back) { result in
            if case .success(let ack) = result { completion(ack.handled ?? false) } else { completion(false) }
        }
    }

    // MARK: bridge

    public func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.handlerName, message.frameInfo.isMainFrame, configuration.isSameOrigin(message.frameInfo.request.url ?? URL(fileURLWithPath: "/")), let text = message.body as? String else { return }
        endpoint.receive(text: text)
    }

    private func handle(_ event: BridgeEvent) {
        switch event {
        case .ready(let info): delegate?.chat(self, didReceiveDeviceId: info.deviceId)
        case .unreadCountChanged(let n): delegate?.chat(self, unreadCountDidChange: n)
        case .error(let code, let message, let fatal) where fatal: delegate?.chat(self, didFailWith: code, message: message)
        case .closeRequested: delegate?.chatDidRequestClose(self)
        default: break
        }
        delegate?.chat(self, didReceive: event)
    }

    // MARK: navigation: the web view stays on the chat's origin; everything else goes to the app's link policy

    public func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == "about" || configuration.isSameOrigin(url) { return decisionHandler(.allow) }
        decisionHandler(.cancel)
        if let safe = LinkPolicy.validated(url.absoluteString), action.navigationType == .linkActivated || action.targetFrame == nil {
            _ = endpointLinkFallback(safe)
        }
    }

    public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // window.open from the page: never a second web view; validated links go to the app
        if let url = action.request.url, let safe = LinkPolicy.validated(url.absoluteString) { _ = endpointLinkFallback(safe) }
        return nil
    }

    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { load() } // iOS killed the page's process: start again

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
    private func failed(_ error: Error) {
        let ns = error as NSError
        if ns.code == NSURLErrorCancelled { return }
        delegate?.chat(self, didFailWith: "NETWORK", message: ns.localizedDescription)
    }

    private func endpointLinkFallback(_ url: URL) -> Bool {
        delegate?.chat(self, shouldOpen: url, source: .message) ?? { UIApplication.shared.open(url); return true }()
    }
}
#endif
