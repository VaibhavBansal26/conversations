#if canImport(SwiftUI) && canImport(UIKit) && canImport(WebKit)
import SwiftUI

/// SwiftUI wrapper. Use `onEvent` to react to the bridge (unread badge, messages), and `commands` to drive the page.
///
///     ConversationsChatView(configuration: config) { event in
///         if case .unreadCountChanged(let n) = event { badge = n }
///     }
@available(iOS 14.0, *)
public struct ConversationsChatView: UIViewControllerRepresentable {
    public var configuration: ConversationsConfiguration
    public var onEvent: (BridgeEvent) -> Void
    public var shouldOpen: ((URL, LinkSource) -> Bool)?

    public init(configuration: ConversationsConfiguration, shouldOpen: ((URL, LinkSource) -> Bool)? = nil, onEvent: @escaping (BridgeEvent) -> Void = { _ in }) {
        self.configuration = configuration
        self.onEvent = onEvent
        self.shouldOpen = shouldOpen
    }

    public func makeCoordinator() -> Coordinator { Coordinator(self) }

    public func makeUIViewController(context: Context) -> ConversationsChatViewController {
        let vc = ConversationsChatViewController(configuration: configuration)
        vc.delegate = context.coordinator
        return vc
    }

    public func updateUIViewController(_ vc: ConversationsChatViewController, context: Context) {
        context.coordinator.parent = self
        // a changed configuration (a different user or token) reloads the chat; the same one does nothing
        if vc.configuration != configuration { vc.reload(with: configuration) }
    }

    public final class Coordinator: NSObject, ConversationsChatDelegate {
        var parent: ConversationsChatView
        init(_ parent: ConversationsChatView) { self.parent = parent }
        public func chat(_ chat: ConversationsChatViewController, didReceive event: BridgeEvent) { parent.onEvent(event) }
        public func chat(_ chat: ConversationsChatViewController, shouldOpen url: URL, source: LinkSource) -> Bool {
            if let handler = parent.shouldOpen { return handler(url, source) }
            UIApplication.shared.open(url)
            return true
        }
    }
}
#endif
