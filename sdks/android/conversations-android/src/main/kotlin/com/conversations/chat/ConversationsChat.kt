package com.conversations.chat

import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

/**
 * Jetpack Compose wrapper (scaffold, not device-tested).
 *
 *     ConversationsChat(activity = this, configuration = config, modifier = Modifier.fillMaxSize()) { event -> ... }
 *
 * [activity] is the hosting `ComponentActivity`; call this composable during the first composition in `setContent` (the file chooser must be
 * registered before the activity is started).
 */
@Composable
fun ConversationsChat(
    activity: ComponentActivity,
    configuration: ConversationsConfiguration,
    modifier: Modifier = Modifier,
    listener: ConversationsChatListener? = null,
    onEvent: (BridgeEvent) -> Unit = {},
) {
    val view = remember(activity) { ConversationsChatView(activity).also { it.attach(activity) } }
    view.listener = object : ConversationsChatListener {
        override fun onEvent(event: BridgeEvent) { listener?.onEvent(event); onEvent(event) }
        override fun shouldOpenLink(url: String, source: LinkSource) = listener?.shouldOpenLink(url, source) ?: false
        override fun onDeviceId(deviceId: String) { listener?.onDeviceId(deviceId) }
    }
    DisposableEffect(view) { onDispose { view.destroy() } }
    AndroidView(modifier = modifier, factory = { view }, update = { if (it.configuration != configuration) it.load(configuration) })
}
