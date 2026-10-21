import Foundation

/// The protocol state machine, free of UIKit and WebKit so it can be unit tested on any platform.
///
/// States: `.loading` (page not ready: commands are queued) -> `.ready` (queue flushed) -> `.failed` (a fatal `error` event: queued and pending
/// commands complete with an error). `reload()` goes back to `.loading`. Not thread safe: call it from one queue (the main queue in the views).
public final class BridgeEndpoint {
    public enum State: Equatable { case loading, ready, failed }

    public private(set) var state: State = .loading
    public private(set) var unreadCount = 0
    public private(set) var deviceId: String?

    /// Called for every event except acks. Runs after the endpoint answered anything the event needs (link acks).
    public var onEvent: (BridgeEvent) -> Void = { _ in }
    /// Decide what happens to a validated link: return true when the app opened it (the page then does not try `window.open`).
    public var linkHandler: (URL, LinkSource) -> Bool = { _, _ in false }
    /// Delivers text to the page (the view runs `bridgeReceiveScript(for:)`).
    private let transport: (String) -> Void

    private struct Pending { let completion: (Result<BridgeAck, BridgeError>) -> Void; let sentAt: TimeInterval }
    private var pending: [String: Pending] = [:]
    private var queued: [(BridgeEnvelope, (Result<BridgeAck, BridgeError>) -> Void)] = []
    private let now: () -> TimeInterval

    public init(now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 }, transport: @escaping (String) -> Void) {
        self.transport = transport
        self.now = now
    }

    /// Queue or send a command. `completion` gets the page's ack, or an error (not ready and failed, too large, timed out).
    public func send(_ command: BridgeCommand, completion: @escaping (Result<BridgeAck, BridgeError>) -> Void = { _ in }) {
        let env = command.envelope()
        switch state {
        case .failed: completion(.failure(.notReady))
        case .loading: queued.append((env, completion))
        case .ready: dispatch(env, completion)
        }
    }

    private func dispatch(_ env: BridgeEnvelope, _ completion: @escaping (Result<BridgeAck, BridgeError>) -> Void) {
        do {
            let text = try env.encodedText()
            pending[env.id] = Pending(completion: completion, sentAt: now())
            transport(text)
        } catch {
            completion(.failure((error as? BridgeError) ?? .tooLarge))
        }
    }

    /// Fail commands that have waited longer than `seconds` for an ack. The view calls this from a timer.
    public func expirePending(olderThan seconds: TimeInterval) {
        let cutoff = now() - seconds
        for (id, p) in pending where p.sentAt <= cutoff {
            pending[id] = nil
            p.completion(.failure(.timedOut))
        }
    }

    /// The page was reloaded or replaced: back to waiting for `ready`; anything in flight is lost.
    public func reload() {
        state = .loading
        let lost = pending
        pending = [:]
        for (_, p) in lost { p.completion(.failure(.notReady)) }
    }

    /// Feed the text of a `WKScriptMessage` (or any transport). Unknown versions and garbage are ignored.
    public func receive(text: String) {
        guard case .success(let env) = EnvelopeDecoding.decode(text) else { return }
        if env.type == "ack" {
            guard let to = env.replyTo, let p = pending.removeValue(forKey: to) else { return }
            p.completion(.success(Self.ack(from: env.payload)))
            return
        }
        guard let event = BridgeEvent.decode(env) else { return }
        switch event {
        case .ready(let info):
            deviceId = info.deviceId
            unreadCount = info.unreadCount
            state = .ready
            let toSend = queued
            queued = []
            for (e, c) in toSend { dispatch(e, c) }
        case .unreadCountChanged(let n):
            unreadCount = n
        case .error(_, _, let fatal) where fatal:
            state = .failed
            let q = queued, p = pending
            queued = []; pending = [:]
            for (_, c) in q { c(.failure(.notReady)) }
            for (_, x) in p { x.completion(.failure(.notReady)) }
        case .linkClicked(let url, let source):
            let handled = linkHandler(url, source)
            let reply = BridgeEnvelope(type: "ack", payload: ["ok": .bool(true), "handled": .bool(handled)], replyTo: env.id)
            if let text = try? reply.encodedText() { transport(text) }
        default: break
        }
        onEvent(event)
    }

    static func ack(from p: [String: JSONValue]) -> BridgeAck {
        BridgeAck(ok: p["ok"]?.boolValue ?? false, handled: p["handled"]?.boolValue, result: p["result"]?.objectValue ?? [:],
                  errorCode: p["error"]?["code"]?.stringValue, errorMessage: p["error"]?["message"]?.stringValue)
    }
}
