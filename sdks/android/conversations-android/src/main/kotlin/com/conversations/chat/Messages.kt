package com.conversations.chat

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

/** Who the visitor is. With [identityHash] (computed by YOUR backend, never in the app) the server verifies the person without a code. */
data class VisitorIdentity(
    val externalId: String? = null,
    val email: String? = null,
    val name: String? = null,
    val phone: String? = null,
    val identityHash: String? = null,
) {
    fun toPayload(): JSONObject = JSONObject().apply {
        externalId?.let { put("external_id", it) }
        email?.let { put("email", it) }
        name?.let { put("name", it) }
        phone?.let { put("phone", it) }
        identityHash?.let { put("identity_hash", it) }
    }
}

enum class Theme(val wire: String) { LIGHT("light"), DARK("dark"), AUTO("auto") }

/** Commands the app sends to the page. */
sealed class BridgeCommand(val type: String) {
    abstract fun payload(): JSONObject

    data class Identify(val identity: VisitorIdentity) : BridgeCommand("identify") { override fun payload() = identity.toPayload() }
    data class SetLanguage(val locale: String, val strings: Map<String, String> = emptyMap()) : BridgeCommand("setLanguage") {
        override fun payload() = JSONObject().put("locale", locale).also { if (strings.isNotEmpty()) it.put("strings", JSONObject(strings)) }
    }
    data class SetTheme(val theme: Theme? = null, val primaryColor: String? = null, val textColor: String? = null) : BridgeCommand("setTheme") {
        override fun payload() = JSONObject().apply {
            theme?.let { put("theme", it.wire) }
            primaryColor?.let { put("primary_color", it) }
            textColor?.let { put("text_color", it) }
        }
    }
    /** Values are String, Number, Boolean or null. */
    data class SetCustomAttributes(val attributes: Map<String, Any?>) : BridgeCommand("setCustomAttributes") {
        override fun payload() = JSONObject().put("attributes", JSONObject().also { o -> attributes.forEach { (k, v) -> o.put(k, v ?: JSONObject.NULL) } })
    }
    object Open : BridgeCommand("open") { override fun payload() = JSONObject() }
    object Close : BridgeCommand("close") { override fun payload() = JSONObject() }
    object Back : BridgeCommand("back") { override fun payload() = JSONObject() }
    object Reset : BridgeCommand("reset") { override fun payload() = JSONObject() }
    data class SendMessage(val text: String, val send: Boolean = false) : BridgeCommand("sendMessage") {
        override fun payload() = JSONObject().put("text", text).put("send", send)
    }
    data class RestoreSession(val deviceId: String) : BridgeCommand("restoreSession") { override fun payload() = JSONObject().put("device_id", deviceId) }

    fun envelope(id: String = java.util.UUID.randomUUID().toString()) = BridgeEnvelope(id = id, type = type, payload = payload())
}

data class ReadyInfo(val pageVersion: String, val deviceId: String, val locale: String, val theme: String, val features: List<String>, val unreadCount: Int)
data class ReceivedMessage(val messageId: String, val senderType: String, val preview: String, val hasAttachments: Boolean, val inForeground: Boolean)
enum class LinkSource { MESSAGE, ATTACHMENT, PAYMENT }
enum class AuthReason { IDENTITY_INVALID, VERIFICATION_REQUIRED, SESSION_EXPIRED, CONFLICT }

/** Events the page sends to the app. */
sealed class BridgeEvent {
    data class Ready(val info: ReadyInfo) : BridgeEvent()
    data class UnreadCountChanged(val count: Int) : BridgeEvent()
    data class MessageReceived(val message: ReceivedMessage) : BridgeEvent()
    data class ConversationStarted(val roomId: String) : BridgeEvent()
    data class ConversationClosed(val roomId: String) : BridgeEvent()
    data class LinkClicked(val url: String, val source: LinkSource) : BridgeEvent()
    data class AttachmentRequested(val kinds: List<String>) : BridgeEvent()
    data class AuthRequired(val reason: AuthReason) : BridgeEvent()
    data class Error(val code: String, val message: String, val fatal: Boolean) : BridgeEvent()
    object CloseRequested : BridgeEvent()
    /** A type added by a newer page within protocol v1: ignored by default, surfaced for logging. */
    data class Unknown(val type: String) : BridgeEvent()

    companion object {
        /** Decode an event envelope. Null for `ack` (handled by the endpoint) and for malformed payloads (never throws). */
        fun decode(env: BridgeEnvelope): BridgeEvent? {
            val p = env.payload
            return when (env.type) {
                "ack" -> null
                "ready" -> {
                    val pv = p.opt("page_version") as? String
                    val dev = p.opt("device_id") as? String
                    val loc = p.opt("locale") as? String
                    val theme = p.opt("theme") as? String
                    val unread = p.opt("unread_count") as? Int
                    if (pv == null || dev == null || loc == null || theme == null || unread == null) null
                    else Ready(ReadyInfo(pv, dev, loc, theme, strings(p.opt("features")), unread))
                }
                "unread_count_changed" -> (p.opt("count") as? Int)?.takeIf { it >= 0 }?.let { UnreadCountChanged(it) }
                "message_received" -> {
                    val id = p.opt("message_id") as? String
                    val st = p.opt("sender_type") as? String
                    val pr = p.opt("preview") as? String
                    val att = p.opt("has_attachments") as? Boolean
                    val fg = p.opt("in_foreground") as? Boolean
                    if (id == null || st == null || pr == null || att == null || fg == null) null else MessageReceived(ReceivedMessage(id, st, pr, att, fg))
                }
                "conversation_started" -> (p.opt("room_id") as? String)?.let { ConversationStarted(it) }
                "conversation_closed" -> (p.opt("room_id") as? String)?.let { ConversationClosed(it) }
                "link_clicked" -> {
                    val url = (p.opt("url") as? String)?.let { LinkPolicy.validated(it) }
                    val src = LinkSource.values().firstOrNull { it.name.equals(p.opt("source") as? String, ignoreCase = true) }
                    if (url == null || src == null) null else LinkClicked(url, src)
                }
                "attachment_requested" -> AttachmentRequested(strings(p.opt("kinds")))
                "auth_required" -> AuthReason.values().firstOrNull { it.name.equals(p.opt("reason") as? String, ignoreCase = true) }?.let { AuthRequired(it) }
                "error" -> {
                    val code = p.opt("code") as? String
                    val msg = p.opt("message") as? String
                    val fatal = p.opt("fatal") as? Boolean
                    if (code == null || msg == null || fatal == null) null else Error(code, msg, fatal)
                }
                "close_requested" -> CloseRequested
                else -> Unknown(env.type)
            }
        }

        private fun strings(v: Any?): List<String> = (v as? JSONArray)?.let { a -> (0 until a.length()).mapNotNull { a.opt(it) as? String } } ?: emptyList()
    }
}

/** The page's answer to a command. */
data class BridgeAck(val ok: Boolean, val handled: Boolean?, val result: JSONObject, val errorCode: String?, val errorMessage: String?)

/** Only https, mailto and tel URLs may be opened from chat content (the page validates too; this is the second check). */
object LinkPolicy {
    fun validated(s: String): String? {
        if (s.length > 2048) return null
        val uri = try { URI(s) } catch (e: Exception) { return null }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "https" && scheme != "mailto" && scheme != "tel") return null
        if (scheme == "https" && uri.host.isNullOrEmpty()) return null
        return s
    }
}
