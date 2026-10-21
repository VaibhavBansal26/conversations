package com.conversations.chat

/** Everything the hosted chat needs. [baseUrl] is the address of your Conversations deployment (its PUBLIC_URL). */
data class ConversationsConfiguration(
    val baseUrl: String,
    /** The embed token (`cvt_...`) of a token with "Hosted chat" switched on. Public by design. */
    val token: String,
    val identity: VisitorIdentity? = null,
    val locale: String? = null,
    val theme: Theme = Theme.AUTO,
    val primaryColor: String? = null,
    /** Let the page pad itself with the safe-area insets (edge-to-edge apps). Default: the view sits inside the system bars. */
    val safeArea: Boolean = false,
    /** The `device_id` from an earlier `ready` event, to continue the same anonymous visitor after storage was cleared. */
    val deviceId: String? = null,
    val showCloseButton: Boolean = false,
    val debug: Boolean = false,
) {
    /** `<baseUrl>/chat?token=...&bridge=android&...` with every value percent-encoded. */
    fun chatUrl(): String {
        val q = ArrayList<Pair<String, String>>()
        q.add("token" to token)
        q.add("bridge" to "android")
        fun add(k: String, v: String?) { if (!v.isNullOrEmpty()) q.add(k to v) }
        add("locale", locale)
        if (theme != Theme.AUTO) add("theme", theme.wire)
        add("primary_color", primaryColor)
        if (safeArea) add("safe_area", "1")
        add("device_id", deviceId)
        if (showCloseButton) add("close_button", "1")
        if (debug) add("debug", "1")
        identity?.let { add("name", it.name); add("email", it.email); add("phone", it.phone); add("external_id", it.externalId); add("identity_hash", it.identityHash) }
        return baseUrl.trimEnd('/') + "/chat?" + q.joinToString("&") { (k, v) -> "${pct(k)}=${pct(v)}" }
    }

    /** scheme://host[:port] of the deployment: the only origin the web view may navigate to. */
    fun origin(): String = originOf(baseUrl)

    fun isSameOrigin(url: String): Boolean = originOf(url) == origin()

    companion object {
        /** RFC 3986 percent-encoding of one query component (unreserved characters stay, everything else is %XX of its UTF-8 bytes). */
        internal fun pct(s: String): String {
            val sb = StringBuilder()
            for (b in s.toByteArray(Charsets.UTF_8)) {
                val c = b.toInt() and 0xFF
                if ((c in 0x30..0x39) || (c in 0x41..0x5A) || (c in 0x61..0x7A) || c == 0x2D || c == 0x2E || c == 0x5F || c == 0x7E) sb.append(c.toChar())
                else sb.append('%').append("0123456789ABCDEF"[c shr 4]).append("0123456789ABCDEF"[c and 15])
            }
            return sb.toString()
        }

        /** Pure-Kotlin origin of an http(s) URL, lower-cased, default ports dropped; "" when it is not one. */
        fun originOf(url: String): String {
            val m = Regex("^(https?)://([^/:?#@]+)(?::(\\d+))?(?:[/?#]|$)", RegexOption.IGNORE_CASE).find(url.trim()) ?: return ""
            val scheme = m.groupValues[1].lowercase()
            val host = m.groupValues[2].lowercase()
            val port = m.groupValues[3]
            val dflt = if (scheme == "https") "443" else "80"
            return "$scheme://$host" + if (port.isNotEmpty() && port != dflt) ":$port" else ""
        }
    }
}
