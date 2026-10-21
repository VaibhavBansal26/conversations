package com.conversations.chat

import org.json.JSONException
import org.json.JSONObject
import java.util.UUID

/** Protocol version spoken by this SDK (docs/MOBILE-BRIDGE.md, docs/bridge/*.schema.json). */
const val BRIDGE_PROTOCOL_VERSION = 1

/** The page rejects anything larger; the SDK refuses to send or accept more. */
const val BRIDGE_MAX_MESSAGE_BYTES = 16_384

enum class BridgeFailure { TOO_LARGE, NOT_JSON, NOT_ENVELOPE, UNSUPPORTED_VERSION, NOT_READY, TIMED_OUT, FAILED }

class BridgeException(val failure: BridgeFailure, message: String = failure.name) : Exception(message)

/** `{ "v": 1, "id": "...", "type": "...", "payload": { ... }, "reply_to": "..." }` */
data class BridgeEnvelope(
    val id: String = UUID.randomUUID().toString(),
    val type: String,
    val payload: JSONObject = JSONObject(),
    val replyTo: String? = null,
) {
    /** The JSON text to send; throws [BridgeException] (TOO_LARGE) over 16 KiB. */
    fun toText(): String {
        val o = JSONObject()
        o.put("v", BRIDGE_PROTOCOL_VERSION)
        o.put("id", id)
        o.put("type", type)
        o.put("payload", payload)
        if (replyTo != null) o.put("reply_to", replyTo)
        val text = o.toString()
        if (text.toByteArray(Charsets.UTF_8).size > BRIDGE_MAX_MESSAGE_BYTES) throw BridgeException(BridgeFailure.TOO_LARGE)
        return text
    }

    companion object {
        /** Parse text sent by the page. Never throws; hostile input yields a failure. An unsupported version is ignored by callers, never answered. */
        fun decode(text: String): Result<BridgeEnvelope> {
            if (text.toByteArray(Charsets.UTF_8).size > BRIDGE_MAX_MESSAGE_BYTES) return fail(BridgeFailure.TOO_LARGE)
            val o = try {
                JSONObject(text)
            } catch (e: JSONException) {
                return fail(BridgeFailure.NOT_JSON)
            }
            if (o.opt("v") != BRIDGE_PROTOCOL_VERSION) return fail(BridgeFailure.UNSUPPORTED_VERSION)
            val id = o.opt("id") as? String
            val type = o.opt("type") as? String
            val payload = o.opt("payload") as? JSONObject
            if (id == null || id.isEmpty() || id.length > 64 || type == null || payload == null) return fail(BridgeFailure.NOT_ENVELOPE)
            val replyTo = o.opt("reply_to") as? String
            return Result.success(BridgeEnvelope(id = id, type = type, payload = payload, replyTo = replyTo))
        }

        private fun fail(f: BridgeFailure): Result<BridgeEnvelope> = Result.failure(BridgeException(f))
    }
}

/**
 * The JavaScript that delivers [text] to the page: `ConversationsBridge.receive("<json text as a JS string>")`. The text is escaped as a JSON
 * string, so quotes, newlines, U+2028 and `</script>` inside it cannot break out of the literal. Identical to the Swift SDK's `bridgeReceiveScript`.
 */
fun bridgeReceiveScript(text: String): String {
    val sb = StringBuilder("\"")
    for (ch in text) {
        when {
            ch == '"' -> sb.append("\\\"")
            ch == '\\' -> sb.append("\\\\")
            ch == '\n' -> sb.append("\\n")
            ch == '\r' -> sb.append("\\r")
            ch == '\t' -> sb.append("\\t")
            ch == ' ' -> sb.append("\\u2028")
            ch == ' ' -> sb.append("\\u2029")
            ch == '<' -> sb.append("\\u003C")
            ch.code < 0x20 -> sb.append(String.format("\\u%04X", ch.code))
            else -> sb.append(ch)
        }
    }
    sb.append('"')
    return "window.ConversationsBridge && window.ConversationsBridge.receive($sb);"
}
