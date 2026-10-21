import XCTest
@testable import ConversationsKit

private func json(_ text: String) -> [String: Any] { try! JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any] }

private func event(_ type: String, _ payload: String, id: String = "e1", v: Int = 1) -> String {
    #"{"v":\#(v),"id":"\#(id)","type":"\#(type)","payload":\#(payload)}"#
}

private let ready = event("ready", #"{"protocol":1,"page_version":"1.0.0","device_id":"device-abc123","locale":"en","theme":"light","features":["emoji"],"unread_count":2}"#)

final class EnvelopeTests: XCTestCase {
    func testEncodesTheDocumentedShape() throws {
        let env = BridgeEnvelope(id: "c1", type: "sendMessage", payload: ["text": .string("hi"), "send": .bool(true)])
        let o = json(try env.encodedText())
        XCTAssertEqual(o["v"] as? Int, 1)
        XCTAssertEqual(o["id"] as? String, "c1")
        XCTAssertEqual(o["type"] as? String, "sendMessage")
        XCTAssertEqual((o["payload"] as? [String: Any])?["text"] as? String, "hi")
        XCTAssertNil(o["reply_to"])
    }

    func testReplyToIsSnakeCase() throws {
        let o = json(try BridgeEnvelope(id: "a1", type: "ack", payload: ["ok": .bool(true)], replyTo: "x9").encodedText())
        XCTAssertEqual(o["reply_to"] as? String, "x9")
    }

    func testDecodeRoundTrip() throws {
        let env = BridgeEnvelope(id: "r1", type: "identify", payload: ["email": .string("a@b.co")])
        guard case .success(let back) = EnvelopeDecoding.decode(try env.encodedText()) else { return XCTFail("decode") }
        XCTAssertEqual(back, env)
    }

    func testRefusesGarbageAndOtherVersionsWithoutCrashing() {
        XCTAssertEqual(EnvelopeDecoding.decode("{not json"), .failure(.notJSON))
        XCTAssertEqual(EnvelopeDecoding.decode("[1,2]"), .failure(.notJSON))
        XCTAssertEqual(EnvelopeDecoding.decode(#"{"v":2,"id":"a","type":"x","payload":{}}"#), .failure(.unsupportedVersion(2)))
        XCTAssertEqual(EnvelopeDecoding.decode(#"{"id":"a","type":"x","payload":{}}"#), .failure(.unsupportedVersion(nil)))
        XCTAssertEqual(EnvelopeDecoding.decode(#"{"v":1,"id":"","type":"x","payload":{}}"#), .failure(.notEnvelope))
        XCTAssertEqual(EnvelopeDecoding.decode(#"{"v":1,"id":"a","type":"x","payload":[]}"#), .failure(.notEnvelope))
        XCTAssertEqual(EnvelopeDecoding.decode(String(repeating: "x", count: bridgeMaxMessageBytes + 1)), .failure(.tooLarge))
    }

    func testRefusesToSendOversizedMessages() {
        let big = BridgeEnvelope(type: "identify", payload: ["name": .string(String(repeating: "x", count: 20_000))])
        XCTAssertThrowsError(try big.encodedText()) { XCTAssertEqual($0 as? BridgeError, .tooLarge) }
    }

    func testReceiveScriptEscapesEverythingThatCouldBreakTheLiteral() {
        let nasty = "a\"b\\c\nd</script>\u{2028}e\u{0001}"
        let js = bridgeReceiveScript(for: nasty)
        XCTAssertTrue(js.hasPrefix("window.ConversationsBridge && window.ConversationsBridge.receive(\""))
        XCTAssertFalse(js.contains("</script>"))
        XCTAssertFalse(js.contains("\n"))
        XCTAssertFalse(js.contains("\u{2028}"))
        XCTAssertTrue(js.contains("\\u003C/script>"))
        XCTAssertTrue(js.contains("\\u0001"))
        XCTAssertTrue(js.contains("a\\\"b\\\\c\\nd"))
    }
}

final class CommandTests: XCTestCase {
    func payload(_ c: BridgeCommand) throws -> [String: Any] { json(try c.envelope(id: "c").encodedText())["payload"] as! [String: Any] }

    func testEveryCommandMatchesTheSchemaShape() throws {
        XCTAssertEqual(try payload(.identify(VisitorIdentity(externalId: "u1", email: "a@b.co", name: "Ana", phone: "+1", identityHash: String(repeating: "a", count: 64)))).keys.sorted(), ["email", "external_id", "identity_hash", "name", "phone"])
        XCTAssertEqual(try payload(.setLanguage(locale: "ja", strings: ["send": "送信"]))["locale"] as? String, "ja")
        XCTAssertEqual((try payload(.setLanguage(locale: "ja", strings: ["send": "送信"]))["strings"] as? [String: String])?["send"], "送信")
        XCTAssertNil(try payload(.setLanguage(locale: "en"))["strings"])
        XCTAssertEqual(try payload(.setTheme(.dark, primaryColor: "#112233"))["theme"] as? String, "dark")
        XCTAssertEqual(try payload(.setTheme(nil, primaryColor: "#112233")).keys.sorted(), ["primary_color"])
        XCTAssertEqual((try payload(.setCustomAttributes(["plan": .string("pro"), "seats": .int(3), "beta": .bool(true), "gone": .null]))["attributes"] as? [String: Any])?.count, 4)
        for c in [BridgeCommand.open, .close, .back, .reset] { XCTAssertTrue(try payload(c).isEmpty, c.type) }
        XCTAssertEqual(try payload(.sendMessage(text: "hi", send: true))["send"] as? Bool, true)
        XCTAssertEqual(try payload(.restoreSession(deviceId: "device-1234"))["device_id"] as? String, "device-1234")
    }

    func testTypesAreTheDocumentedCommandNames() {
        let names = [BridgeCommand.identify(VisitorIdentity()), .setLanguage(locale: "en"), .setTheme(nil), .setCustomAttributes([:]), .open, .close, .back, .reset, .sendMessage(text: "x"), .restoreSession(deviceId: "device-1234")].map { $0.type }
        XCTAssertEqual(names, ["identify", "setLanguage", "setTheme", "setCustomAttributes", "open", "close", "back", "reset", "sendMessage", "restoreSession"])
    }
}

final class EventTests: XCTestCase {
    private func decode(_ type: String, _ payload: String) -> BridgeEvent? {
        guard case .success(let env) = EnvelopeDecoding.decode(event(type, payload)) else { return nil }
        return BridgeEvent.decode(env)
    }

    func testDecodesEveryEvent() {
        XCTAssertEqual(decode("ready", #"{"protocol":1,"page_version":"1.0.0","device_id":"device-abc123","locale":"en","theme":"dark","features":["a","b"],"unread_count":3}"#), .ready(ReadyInfo(pageVersion: "1.0.0", deviceId: "device-abc123", locale: "en", theme: "dark", features: ["a", "b"], unreadCount: 3)))
        XCTAssertEqual(decode("unread_count_changed", #"{"count":4}"#), .unreadCountChanged(4))
        XCTAssertEqual(decode("message_received", #"{"message_id":"m1","sender_type":"agent","preview":"hi","has_attachments":false,"in_foreground":true}"#), .messageReceived(ReceivedMessage(messageId: "m1", senderType: "agent", preview: "hi", hasAttachments: false, inForeground: true)))
        XCTAssertEqual(decode("conversation_started", #"{"room_id":"room_1"}"#), .conversationStarted(roomId: "room_1"))
        XCTAssertEqual(decode("conversation_closed", #"{"room_id":"room_1"}"#), .conversationClosed(roomId: "room_1"))
        XCTAssertEqual(decode("link_clicked", #"{"url":"https://example.com/x","source":"payment"}"#), .linkClicked(url: URL(string: "https://example.com/x")!, source: .payment))
        XCTAssertEqual(decode("attachment_requested", #"{"kinds":["image","pdf"]}"#), .attachmentRequested(kinds: ["image", "pdf"]))
        XCTAssertEqual(decode("auth_required", #"{"reason":"identity_invalid"}"#), .authRequired(.identityInvalid))
        XCTAssertEqual(decode("error", #"{"code":"UNAVAILABLE","message":"m","fatal":true}"#), .error(code: "UNAVAILABLE", message: "m", fatal: true))
        XCTAssertEqual(decode("close_requested", "{}"), .closeRequested)
        XCTAssertEqual(decode("brand_new_event", "{}"), .unknown(type: "brand_new_event"))
    }

    func testMalformedPayloadsAreDroppedNotCrashed() {
        XCTAssertNil(decode("ready", #"{"protocol":1}"#))
        XCTAssertNil(decode("unread_count_changed", #"{"count":-1}"#))
        XCTAssertNil(decode("unread_count_changed", #"{"count":"3"}"#))
        XCTAssertNil(decode("auth_required", #"{"reason":"nope"}"#))
        XCTAssertNil(decode("conversation_started", "{}"))
    }

    func testLinksOutsideHttpsMailtoTelNeverBecomeEvents() {
        for bad in ["javascript:alert(1)", "http://example.com", "file:///etc/passwd", "data:text/html,x", "intent://x", "https://", "not a url"] {
            XCTAssertNil(decode("link_clicked", #"{"url":"\#(bad)","source":"message"}"#), bad)
        }
        for ok in ["https://example.com", "mailto:a@b.co", "tel:+14155550123"] { XCTAssertNotNil(LinkPolicy.validated(ok), ok) }
        XCTAssertNil(LinkPolicy.validated("https://example.com/" + String(repeating: "a", count: 2100)))
    }
}

final class EndpointTests: XCTestCase {
    private var sent: [BridgeEnvelope] = []
    private var clock: TimeInterval = 1000
    private func endpoint() -> BridgeEndpoint {
        sent = []
        return BridgeEndpoint(now: { self.clock }) { text in
            if case .success(let e) = EnvelopeDecoding.decode(text) { self.sent.append(e) }
        }
    }
    private func ack(_ to: String, _ payload: String = #"{"ok":true}"#) -> String { #"{"v":1,"id":"ack-\#(to)","type":"ack","payload":\#(payload),"reply_to":"\#(to)"}"# }

    func testQueuesUntilReadyThenFlushesInOrder() {
        let ep = endpoint()
        ep.send(.open); ep.send(.identify(VisitorIdentity(name: "Ana")))
        XCTAssertEqual(ep.state, .loading)
        XCTAssertTrue(sent.isEmpty)
        ep.receive(text: ready)
        XCTAssertEqual(ep.state, .ready)
        XCTAssertEqual(sent.map { $0.type }, ["open", "identify"])
        XCTAssertEqual(ep.deviceId, "device-abc123")
        XCTAssertEqual(ep.unreadCount, 2)
        ep.send(.close)
        XCTAssertEqual(sent.map { $0.type }, ["open", "identify", "close"])
    }

    func testAckCompletesTheCommandOnceAndNackCarriesTheError() {
        let ep = endpoint()
        ep.receive(text: ready)
        var results: [Result<BridgeAck, BridgeError>] = []
        ep.send(.sendMessage(text: "hi", send: true)) { results.append($0) }
        ep.send(.setTheme(.dark)) { results.append($0) }
        ep.receive(text: ack(sent[0].id, #"{"ok":true,"result":{"sent":true,"message_id":"m1"}}"#))
        ep.receive(text: ack(sent[0].id)) // a second ack for the same command is ignored
        ep.receive(text: ack(sent[1].id, #"{"ok":false,"error":{"code":"INVALID_PAYLOAD","message":"bad"}}"#))
        XCTAssertEqual(results.count, 2)
        guard case .success(let a) = results[0] else { return XCTFail() }
        XCTAssertTrue(a.ok); XCTAssertEqual(a.result["sent"], .bool(true)); XCTAssertEqual(a.result["message_id"], .string("m1"))
        guard case .success(let b) = results[1] else { return XCTFail() }
        XCTAssertFalse(b.ok); XCTAssertEqual(b.errorCode, "INVALID_PAYLOAD")
    }

    func testBackReportsWhetherThePageHandledIt() {
        let ep = endpoint(); ep.receive(text: ready)
        var handled: Bool?
        ep.send(.back) { if case .success(let a) = $0 { handled = a.handled } }
        ep.receive(text: ack(sent[0].id, #"{"ok":true,"handled":true}"#))
        XCTAssertEqual(handled, true)
    }

    func testUnansweredCommandsTimeOut() {
        let ep = endpoint(); ep.receive(text: ready)
        var got: Result<BridgeAck, BridgeError>?
        ep.send(.open) { got = $0 }
        clock += 5; ep.expirePending(olderThan: 10); XCTAssertNil(got)
        clock += 6; ep.expirePending(olderThan: 10)
        XCTAssertEqual(got, .failure(.timedOut))
    }

    func testLinkClickedIsAnsweredWithHandledAndRelayed() {
        let ep = endpoint(); ep.receive(text: ready)
        var events: [BridgeEvent] = []
        ep.onEvent = { events.append($0) }
        var asked: [(URL, LinkSource)] = []
        ep.linkHandler = { url, src in asked.append((url, src)); return true }
        ep.receive(text: event("link_clicked", #"{"url":"https://example.com/docs","source":"message"}"#, id: "L1"))
        XCTAssertEqual(asked.count, 1)
        XCTAssertEqual(sent.last?.type, "ack")
        XCTAssertEqual(sent.last?.replyTo, "L1")
        XCTAssertEqual(sent.last?.payload["handled"], .bool(true))
        XCTAssertEqual(events, [.linkClicked(url: URL(string: "https://example.com/docs")!, source: .message)])
        // a hostile link is dropped before it reaches the app and gets no ack
        let before = sent.count
        ep.receive(text: event("link_clicked", #"{"url":"javascript:alert(1)","source":"message"}"#, id: "L2"))
        XCTAssertEqual(sent.count, before)
        XCTAssertEqual(asked.count, 1)
    }

    func testUnreadCountIsTracked() {
        let ep = endpoint(); ep.receive(text: ready)
        ep.receive(text: event("unread_count_changed", #"{"count":7}"#))
        XCTAssertEqual(ep.unreadCount, 7)
    }

    func testFatalErrorFailsQueuedAndPendingAndLaterCommands() {
        let ep = endpoint()
        var results: [Result<BridgeAck, BridgeError>] = []
        ep.send(.open) { results.append($0) }           // queued, page never became ready
        ep.receive(text: event("error", #"{"code":"UNAVAILABLE","message":"nope","fatal":true}"#))
        XCTAssertEqual(ep.state, .failed)
        ep.send(.close) { results.append($0) }
        XCTAssertEqual(results, [.failure(.notReady), .failure(.notReady)])
    }

    func testNonFatalErrorKeepsRunningAndIsRelayed() {
        let ep = endpoint(); ep.receive(text: ready)
        var events: [BridgeEvent] = []
        ep.onEvent = { events.append($0) }
        ep.receive(text: event("error", #"{"code":"X","message":"soft","fatal":false}"#))
        XCTAssertEqual(ep.state, .ready)
        XCTAssertEqual(events, [.error(code: "X", message: "soft", fatal: false)])
    }

    func testReloadGoesBackToLoadingAndFailsInFlightCommands() {
        let ep = endpoint(); ep.receive(text: ready)
        var got: Result<BridgeAck, BridgeError>?
        ep.send(.open) { got = $0 }
        ep.reload()
        XCTAssertEqual(ep.state, .loading)
        XCTAssertEqual(got, .failure(.notReady))
        ep.send(.close)
        XCTAssertEqual(sent.map { $0.type }, ["open"]) // close waits for the new ready
        ep.receive(text: ready)
        XCTAssertEqual(sent.map { $0.type }, ["open", "close"])
    }

    func testIgnoresUnknownVersionsGarbageAndForeignAcks() {
        let ep = endpoint()
        var events: [BridgeEvent] = []
        ep.onEvent = { events.append($0) }
        ep.receive(text: event("ready", "{}", v: 2))
        ep.receive(text: "garbage")
        ep.receive(text: ack("nobody-waits"))
        XCTAssertEqual(ep.state, .loading)
        XCTAssertTrue(events.isEmpty)
        XCTAssertTrue(sent.isEmpty)
    }

    func testUnknownEventTypesWithinV1AreRelayedAsUnknown() {
        let ep = endpoint(); ep.receive(text: ready)
        var events: [BridgeEvent] = []
        ep.onEvent = { events.append($0) }
        ep.receive(text: event("typing_started", "{}"))
        XCTAssertEqual(events, [.unknown(type: "typing_started")])
    }
}

final class ConfigurationTests: XCTestCase {
    func testChatURLEncodesEveryValueAndOmitsDefaults() throws {
        let c = ConversationsConfiguration(baseURL: URL(string: "https://chat.example.com/")!, token: "cvt_abc", identity: VisitorIdentity(externalId: "u 1", email: "ana+x@example.com", name: "Ana & Co", identityHash: String(repeating: "a", count: 64)), locale: "pt-BR", theme: .dark, primaryColor: "#112233", safeArea: true, deviceId: "device-abc123", showCloseButton: true)
        let url = c.chatURL
        XCTAssertEqual(url.scheme, "https"); XCTAssertEqual(url.host, "chat.example.com"); XCTAssertEqual(url.path, "/chat")
        let items = Dictionary(uniqueKeysWithValues: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(items["token"], "cvt_abc")
        XCTAssertEqual(items["bridge"], "ios")
        XCTAssertEqual(items["external_id"], "u 1")
        XCTAssertEqual(items["email"], "ana+x@example.com")
        XCTAssertEqual(items["name"], "Ana & Co")
        XCTAssertEqual(items["theme"], "dark")
        XCTAssertEqual(items["safe_area"], "1")
        XCTAssertEqual(items["close_button"], "1")
        XCTAssertFalse(url.absoluteString.contains("Ana & Co")) // the ampersand and spaces are encoded
        let plain = ConversationsConfiguration(baseURL: URL(string: "http://localhost:3000")!, token: "cvt_abc").chatURL
        XCTAssertEqual(plain.absoluteString, "http://localhost:3000/chat?token=cvt_abc&bridge=ios")
    }

    func testBasePathIsKeptAndOriginComparisonIsExact() {
        let c = ConversationsConfiguration(baseURL: URL(string: "https://example.com:8443/support/")!, token: "t")
        XCTAssertEqual(c.chatURL.path, "/support/chat")
        XCTAssertEqual(c.origin, "https://example.com:8443")
        XCTAssertTrue(c.isSameOrigin(URL(string: "https://example.com:8443/chat/assets/chat.js")!))
        for other in ["https://example.com/chat", "http://example.com:8443/", "https://evil.com:8443/", "https://example.com.evil.com:8443/", "https://sub.example.com:8443/"] {
            XCTAssertFalse(c.isSameOrigin(URL(string: other)!), other)
        }
    }
}
