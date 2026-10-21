package com.conversations.chat

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun ev(type: String, payload: String, id: String = "e1", v: Int = 1) = """{"v":$v,"id":"$id","type":"$type","payload":$payload}"""
private val READY = ev("ready", """{"protocol":1,"page_version":"1.0.0","device_id":"device-abc123","locale":"en","theme":"light","features":["emoji"],"unread_count":2}""")

class EnvelopeTest {
    @Test fun encodesTheDocumentedShape() {
        val o = JSONObject(BridgeEnvelope(id = "c1", type = "sendMessage", payload = JSONObject().put("text", "hi").put("send", true)).toText())
        assertEquals(1, o.getInt("v"))
        assertEquals("c1", o.getString("id"))
        assertEquals("sendMessage", o.getString("type"))
        assertEquals("hi", o.getJSONObject("payload").getString("text"))
        assertFalse(o.has("reply_to"))
    }

    @Test fun replyToIsSnakeCase() {
        assertEquals("x9", JSONObject(BridgeEnvelope(id = "a1", type = "ack", payload = JSONObject().put("ok", true), replyTo = "x9").toText()).getString("reply_to"))
    }

    @Test fun decodeRoundTrip() {
        val env = BridgeEnvelope(id = "r1", type = "identify", payload = JSONObject().put("email", "a@b.co"))
        val back = BridgeEnvelope.decode(env.toText()).getOrThrow()
        assertEquals("r1", back.id); assertEquals("identify", back.type); assertEquals("a@b.co", back.payload.getString("email"))
    }

    private fun failure(text: String) = (BridgeEnvelope.decode(text).exceptionOrNull() as BridgeException).failure

    @Test fun refusesGarbageAndOtherVersionsWithoutThrowing() {
        assertEquals(BridgeFailure.NOT_JSON, failure("{not json"))
        assertEquals(BridgeFailure.NOT_JSON, failure("[1,2]"))
        assertEquals(BridgeFailure.UNSUPPORTED_VERSION, failure("""{"v":2,"id":"a","type":"x","payload":{}}"""))
        assertEquals(BridgeFailure.UNSUPPORTED_VERSION, failure("""{"id":"a","type":"x","payload":{}}"""))
        assertEquals(BridgeFailure.NOT_ENVELOPE, failure("""{"v":1,"id":"","type":"x","payload":{}}"""))
        assertEquals(BridgeFailure.NOT_ENVELOPE, failure("""{"v":1,"id":"a","type":"x","payload":[]}"""))
        assertEquals(BridgeFailure.TOO_LARGE, failure("x".repeat(BRIDGE_MAX_MESSAGE_BYTES + 1)))
    }

    @Test fun refusesToSendOversizedMessages() {
        val big = BridgeEnvelope(type = "identify", payload = JSONObject().put("name", "x".repeat(20_000)))
        try { big.toText(); throw AssertionError("expected TOO_LARGE") } catch (e: BridgeException) { assertEquals(BridgeFailure.TOO_LARGE, e.failure) }
    }

    @Test fun receiveScriptEscapesEverythingThatCouldBreakTheLiteral() {
        val js = bridgeReceiveScript("a\"b\\c\nd</script>\u2028e\u0001")
        assertTrue(js.startsWith("window.ConversationsBridge && window.ConversationsBridge.receive(\""))
        assertFalse(js.contains("</script>")); assertFalse(js.contains("\n")); assertFalse(js.contains("\u2028"))
        assertTrue(js.contains("\\u003C/script>")); assertTrue(js.contains("\\u0001")); assertTrue(js.contains("a\\\"b\\\\c\\nd"))
    }
}

class CommandTest {
    @Test fun typesAreTheDocumentedCommandNames() {
        val names = listOf(BridgeCommand.Identify(VisitorIdentity()), BridgeCommand.SetLanguage("en"), BridgeCommand.SetTheme(), BridgeCommand.SetCustomAttributes(emptyMap()), BridgeCommand.Open, BridgeCommand.Close, BridgeCommand.Back, BridgeCommand.Reset, BridgeCommand.SendMessage("x"), BridgeCommand.RestoreSession("device-1234")).map { it.type }
        assertEquals(listOf("identify", "setLanguage", "setTheme", "setCustomAttributes", "open", "close", "back", "reset", "sendMessage", "restoreSession"), names)
    }

    @Test fun payloadsMatchTheSchemaShape() {
        val id = BridgeCommand.Identify(VisitorIdentity("u1", "a@b.co", "Ana", "+1", "a".repeat(64))).payload()
        assertEquals(setOf("external_id", "email", "name", "phone", "identity_hash"), id.keys().asSequence().toSet())
        assertEquals("ja", BridgeCommand.SetLanguage("ja", mapOf("send" to "送信")).payload().getString("locale"))
        assertEquals("送信", BridgeCommand.SetLanguage("ja", mapOf("send" to "送信")).payload().getJSONObject("strings").getString("send"))
        assertFalse(BridgeCommand.SetLanguage("en").payload().has("strings"))
        assertEquals("dark", BridgeCommand.SetTheme(Theme.DARK, "#112233").payload().getString("theme"))
        assertEquals(setOf("primary_color"), BridgeCommand.SetTheme(null, "#112233").payload().keys().asSequence().toSet())
        val attrs = BridgeCommand.SetCustomAttributes(mapOf("plan" to "pro", "seats" to 3, "beta" to true, "gone" to null)).payload().getJSONObject("attributes")
        assertEquals(4, attrs.length()); assertTrue(attrs.isNull("gone"))
        for (c in listOf(BridgeCommand.Open, BridgeCommand.Close, BridgeCommand.Back, BridgeCommand.Reset)) assertEquals(0, c.payload().length())
        assertTrue(BridgeCommand.SendMessage("hi", true).payload().getBoolean("send"))
        assertEquals("device-1234", BridgeCommand.RestoreSession("device-1234").payload().getString("device_id"))
    }
}

class EventTest {
    private fun decode(type: String, payload: String): BridgeEvent? = BridgeEvent.decode(BridgeEnvelope.decode(ev(type, payload)).getOrThrow())

    @Test fun decodesEveryEvent() {
        assertEquals(BridgeEvent.Ready(ReadyInfo("1.0.0", "device-abc123", "en", "dark", listOf("a", "b"), 3)), decode("ready", """{"protocol":1,"page_version":"1.0.0","device_id":"device-abc123","locale":"en","theme":"dark","features":["a","b"],"unread_count":3}"""))
        assertEquals(BridgeEvent.UnreadCountChanged(4), decode("unread_count_changed", """{"count":4}"""))
        assertEquals(BridgeEvent.MessageReceived(ReceivedMessage("m1", "agent", "hi", false, true)), decode("message_received", """{"message_id":"m1","sender_type":"agent","preview":"hi","has_attachments":false,"in_foreground":true}"""))
        assertEquals(BridgeEvent.ConversationStarted("room_1"), decode("conversation_started", """{"room_id":"room_1"}"""))
        assertEquals(BridgeEvent.ConversationClosed("room_1"), decode("conversation_closed", """{"room_id":"room_1"}"""))
        assertEquals(BridgeEvent.LinkClicked("https://example.com/x", LinkSource.PAYMENT), decode("link_clicked", """{"url":"https://example.com/x","source":"payment"}"""))
        assertEquals(BridgeEvent.AttachmentRequested(listOf("image", "pdf")), decode("attachment_requested", """{"kinds":["image","pdf"]}"""))
        assertEquals(BridgeEvent.AuthRequired(AuthReason.IDENTITY_INVALID), decode("auth_required", """{"reason":"identity_invalid"}"""))
        assertEquals(BridgeEvent.Error("UNAVAILABLE", "m", true), decode("error", """{"code":"UNAVAILABLE","message":"m","fatal":true}"""))
        assertEquals(BridgeEvent.CloseRequested, decode("close_requested", "{}"))
        assertEquals(BridgeEvent.Unknown("brand_new_event"), decode("brand_new_event", "{}"))
    }

    @Test fun malformedPayloadsAreDroppedNotThrown() {
        assertNull(decode("ready", """{"protocol":1}"""))
        assertNull(decode("unread_count_changed", """{"count":-1}"""))
        assertNull(decode("unread_count_changed", """{"count":"3"}"""))
        assertNull(decode("auth_required", """{"reason":"nope"}"""))
        assertNull(decode("conversation_started", "{}"))
    }

    @Test fun linksOutsideHttpsMailtoTelNeverBecomeEvents() {
        for (bad in listOf("javascript:alert(1)", "http://example.com", "file:///etc/passwd", "data:text/html,x", "intent://x", "https://", "not a url")) {
            assertNull(bad, decode("link_clicked", """{"url":"$bad","source":"message"}"""))
        }
        for (ok in listOf("https://example.com", "mailto:a@b.co", "tel:+14155550123")) assertNotNull(ok, LinkPolicy.validated(ok))
        assertNull(LinkPolicy.validated("https://example.com/" + "a".repeat(2100)))
    }
}

class EndpointTest {
    private val sent = ArrayList<BridgeEnvelope>()
    private var clock = 1_000_000L
    private fun endpoint(): BridgeEndpoint { sent.clear(); return BridgeEndpoint(now = { clock }) { text -> BridgeEnvelope.decode(text).getOrNull()?.let { sent.add(it) } } }
    private fun ack(to: String, payload: String = """{"ok":true}""") = """{"v":1,"id":"ack-$to","type":"ack","payload":$payload,"reply_to":"$to"}"""

    @Test fun queuesUntilReadyThenFlushesInOrder() {
        val ep = endpoint()
        ep.send(BridgeCommand.Open); ep.send(BridgeCommand.Identify(VisitorIdentity(name = "Ana")))
        assertEquals(BridgeEndpoint.State.LOADING, ep.state); assertTrue(sent.isEmpty())
        ep.receive(READY)
        assertEquals(BridgeEndpoint.State.READY, ep.state)
        assertEquals(listOf("open", "identify"), sent.map { it.type })
        assertEquals("device-abc123", ep.deviceId); assertEquals(2, ep.unreadCount)
        ep.send(BridgeCommand.Close)
        assertEquals(listOf("open", "identify", "close"), sent.map { it.type })
    }

    @Test fun ackCompletesTheCommandOnceAndNackCarriesTheError() {
        val ep = endpoint(); ep.receive(READY)
        val results = ArrayList<Result<BridgeAck>>()
        ep.send(BridgeCommand.SendMessage("hi", true)) { results.add(it) }
        ep.send(BridgeCommand.SetTheme(Theme.DARK)) { results.add(it) }
        ep.receive(ack(sent[0].id, """{"ok":true,"result":{"sent":true,"message_id":"m1"}}"""))
        ep.receive(ack(sent[0].id))
        ep.receive(ack(sent[1].id, """{"ok":false,"error":{"code":"INVALID_PAYLOAD","message":"bad"}}"""))
        assertEquals(2, results.size)
        val a = results[0].getOrThrow(); assertTrue(a.ok); assertTrue(a.result.getBoolean("sent")); assertEquals("m1", a.result.getString("message_id"))
        val b = results[1].getOrThrow(); assertFalse(b.ok); assertEquals("INVALID_PAYLOAD", b.errorCode)
    }

    @Test fun backReportsWhetherThePageHandledIt() {
        val ep = endpoint(); ep.receive(READY)
        var handled: Boolean? = null
        ep.send(BridgeCommand.Back) { handled = it.getOrNull()?.handled }
        ep.receive(ack(sent[0].id, """{"ok":true,"handled":true}"""))
        assertEquals(true, handled)
    }

    @Test fun unansweredCommandsTimeOut() {
        val ep = endpoint(); ep.receive(READY)
        var got: Result<BridgeAck>? = null
        ep.send(BridgeCommand.Open) { got = it }
        clock += 5_000; ep.expirePending(10_000); assertNull(got)
        clock += 6_000; ep.expirePending(10_000)
        assertEquals(BridgeFailure.TIMED_OUT, (got!!.exceptionOrNull() as BridgeException).failure)
    }

    @Test fun linkClickedIsAnsweredWithHandledAndRelayed() {
        val ep = endpoint(); ep.receive(READY)
        val events = ArrayList<BridgeEvent>(); ep.onEvent = { events.add(it) }
        val asked = ArrayList<Pair<String, LinkSource>>(); ep.linkHandler = { u, s -> asked.add(u to s); true }
        ep.receive(ev("link_clicked", """{"url":"https://example.com/docs","source":"message"}""", id = "L1"))
        assertEquals(1, asked.size)
        assertEquals("ack", sent.last().type); assertEquals("L1", sent.last().replyTo); assertTrue(sent.last().payload.getBoolean("handled"))
        assertEquals(listOf<BridgeEvent>(BridgeEvent.LinkClicked("https://example.com/docs", LinkSource.MESSAGE)), events)
        val before = sent.size
        ep.receive(ev("link_clicked", """{"url":"javascript:alert(1)","source":"message"}""", id = "L2"))
        assertEquals(before, sent.size); assertEquals(1, asked.size)
    }

    @Test fun unreadCountIsTracked() {
        val ep = endpoint(); ep.receive(READY)
        ep.receive(ev("unread_count_changed", """{"count":7}"""))
        assertEquals(7, ep.unreadCount)
    }

    @Test fun fatalErrorFailsQueuedAndPendingAndLaterCommands() {
        val ep = endpoint()
        val results = ArrayList<Result<BridgeAck>>()
        ep.send(BridgeCommand.Open) { results.add(it) }
        ep.receive(ev("error", """{"code":"UNAVAILABLE","message":"nope","fatal":true}"""))
        assertEquals(BridgeEndpoint.State.FAILED, ep.state)
        ep.send(BridgeCommand.Close) { results.add(it) }
        assertEquals(2, results.size); assertTrue(results.all { it.isFailure })
    }

    @Test fun nonFatalErrorKeepsRunningAndIsRelayed() {
        val ep = endpoint(); ep.receive(READY)
        val events = ArrayList<BridgeEvent>(); ep.onEvent = { events.add(it) }
        ep.receive(ev("error", """{"code":"X","message":"soft","fatal":false}"""))
        assertEquals(BridgeEndpoint.State.READY, ep.state)
        assertEquals(listOf<BridgeEvent>(BridgeEvent.Error("X", "soft", false)), events)
    }

    @Test fun reloadGoesBackToLoadingAndFailsInFlightCommands() {
        val ep = endpoint(); ep.receive(READY)
        var got: Result<BridgeAck>? = null
        ep.send(BridgeCommand.Open) { got = it }
        ep.reload()
        assertEquals(BridgeEndpoint.State.LOADING, ep.state); assertTrue(got!!.isFailure)
        ep.send(BridgeCommand.Close)
        assertEquals(listOf("open"), sent.map { it.type })
        ep.receive(READY)
        assertEquals(listOf("open", "close"), sent.map { it.type })
    }

    @Test fun ignoresUnknownVersionsGarbageAndForeignAcks() {
        val ep = endpoint()
        val events = ArrayList<BridgeEvent>(); ep.onEvent = { events.add(it) }
        ep.receive(ev("ready", "{}", v = 2)); ep.receive("garbage"); ep.receive(ack("nobody-waits"))
        assertEquals(BridgeEndpoint.State.LOADING, ep.state); assertTrue(events.isEmpty()); assertTrue(sent.isEmpty())
    }
}

class ConfigurationTest {
    @Test fun chatUrlEncodesEveryValueAndOmitsDefaults() {
        val c = ConversationsConfiguration("https://chat.example.com/", "cvt_abc", VisitorIdentity("u 1", "ana+x@example.com", "Ana & Co", identityHash = "a".repeat(64)), "pt-BR", Theme.DARK, "#112233", true, "device-abc123", true)
        val url = c.chatUrl()
        assertTrue(url.startsWith("https://chat.example.com/chat?token=cvt_abc&bridge=android"))
        for (part in listOf("external_id=u%201", "email=ana%2Bx%40example.com", "name=Ana%20%26%20Co", "theme=dark", "safe_area=1", "close_button=1", "primary_color=%23112233", "locale=pt-BR", "device_id=device-abc123")) assertTrue(part, url.contains(part))
        assertEquals("http://localhost:3000/chat?token=cvt_abc&bridge=android", ConversationsConfiguration("http://localhost:3000", "cvt_abc").chatUrl())
    }

    @Test fun originComparisonIsExact() {
        val c = ConversationsConfiguration("https://example.com:8443/support/", "t")
        assertEquals("https://example.com:8443", c.origin())
        assertTrue(c.isSameOrigin("https://example.com:8443/chat/assets/chat.js"))
        for (other in listOf("https://example.com/chat", "http://example.com:8443/", "https://evil.com:8443/", "https://example.com.evil.com:8443/", "https://sub.example.com:8443/", "https://user@evil.com:8443/", "javascript:alert(1)", "")) assertFalse(other, c.isSameOrigin(other))
        assertEquals("https://example.com", ConversationsConfiguration.originOf("HTTPS://Example.com:443/x"))
    }
}
