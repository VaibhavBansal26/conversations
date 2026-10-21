package com.conversations.chat

import org.json.JSONObject

/**
 * The protocol state machine, free of Android classes so it is unit tested on the JVM.
 *
 * States: LOADING (page not ready: commands are queued) -> READY (queue flushed) -> FAILED (a fatal `error` event: queued and pending commands
 * complete with an error). [reload] goes back to LOADING. Not thread safe: call it from one thread (the main thread in the views).
 */
class BridgeEndpoint(
    private val now: () -> Long = { System.currentTimeMillis() },
    private val transport: (String) -> Unit,
) {
    enum class State { LOADING, READY, FAILED }

    var state: State = State.LOADING
        private set
    var unreadCount: Int = 0
        private set
    var deviceId: String? = null
        private set

    /** Called for every event except acks. */
    var onEvent: (BridgeEvent) -> Unit = {}

    /** Decide what happens to a validated link: return true when the app opened it (the page then does not try `window.open`). */
    var linkHandler: (String, LinkSource) -> Boolean = { _, _ -> false }

    private class Pending(val completion: (Result<BridgeAck>) -> Unit, val sentAt: Long)

    private val pending = HashMap<String, Pending>()
    private val queued = ArrayList<Pair<BridgeEnvelope, (Result<BridgeAck>) -> Unit>>()

    /** Queue or send a command. [completion] gets the page's ack, or a failure (not ready, too large, timed out). */
    fun send(command: BridgeCommand, completion: (Result<BridgeAck>) -> Unit = {}) {
        val env = command.envelope()
        when (state) {
            State.FAILED -> completion(Result.failure(BridgeException(BridgeFailure.NOT_READY)))
            State.LOADING -> queued.add(env to completion)
            State.READY -> dispatch(env, completion)
        }
    }

    private fun dispatch(env: BridgeEnvelope, completion: (Result<BridgeAck>) -> Unit) {
        val text = try {
            env.toText()
        } catch (e: BridgeException) {
            completion(Result.failure(e))
            return
        }
        pending[env.id] = Pending(completion, now())
        transport(text)
    }

    /** Fail commands that have waited longer than [millis] for an ack. The view calls this from a timer. */
    fun expirePending(olderThanMillis: Long) {
        val cutoff = now() - olderThanMillis
        val expired = pending.filterValues { it.sentAt <= cutoff }
        expired.keys.forEach { pending.remove(it) }
        expired.values.forEach { it.completion(Result.failure(BridgeException(BridgeFailure.TIMED_OUT))) }
    }

    /** The page was reloaded or replaced: back to waiting for `ready`; anything in flight is lost. */
    fun reload() {
        state = State.LOADING
        val lost = pending.values.toList()
        pending.clear()
        lost.forEach { it.completion(Result.failure(BridgeException(BridgeFailure.NOT_READY))) }
    }

    /** Feed the text received from the page. Unknown versions and garbage are ignored. */
    fun receive(text: String) {
        val env = BridgeEnvelope.decode(text).getOrNull() ?: return
        if (env.type == "ack") {
            val to = env.replyTo ?: return
            val p = pending.remove(to) ?: return
            p.completion(Result.success(ack(env.payload)))
            return
        }
        val event = BridgeEvent.decode(env) ?: return
        when (event) {
            is BridgeEvent.Ready -> {
                deviceId = event.info.deviceId
                unreadCount = event.info.unreadCount
                state = State.READY
                val toSend = queued.toList()
                queued.clear()
                toSend.forEach { (e, c) -> dispatch(e, c) }
            }
            is BridgeEvent.UnreadCountChanged -> unreadCount = event.count
            is BridgeEvent.Error -> if (event.fatal) {
                state = State.FAILED
                val q = queued.toList()
                val p = pending.values.toList()
                queued.clear()
                pending.clear()
                q.forEach { it.second(Result.failure(BridgeException(BridgeFailure.NOT_READY))) }
                p.forEach { it.completion(Result.failure(BridgeException(BridgeFailure.NOT_READY))) }
            }
            is BridgeEvent.LinkClicked -> {
                val handled = linkHandler(event.url, event.source)
                val reply = BridgeEnvelope(type = "ack", payload = JSONObject().put("ok", true).put("handled", handled), replyTo = env.id)
                runCatching { transport(reply.toText()) }
            }
            else -> Unit
        }
        onEvent(event)
    }

    private fun ack(p: JSONObject): BridgeAck {
        val err = p.optJSONObject("error")
        return BridgeAck(
            ok = p.optBoolean("ok", false),
            handled = if (p.has("handled")) p.optBoolean("handled") else null,
            result = p.optJSONObject("result") ?: JSONObject(),
            errorCode = err?.optString("code"),
            errorMessage = err?.optString("message"),
        )
    }
}
