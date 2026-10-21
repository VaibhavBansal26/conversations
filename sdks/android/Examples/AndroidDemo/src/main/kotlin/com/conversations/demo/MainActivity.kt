package com.conversations.demo

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.conversations.chat.BridgeEvent
import com.conversations.chat.ConversationsChat
import com.conversations.chat.ConversationsConfiguration

/** Opens the hosted chat of the deployment configured in build.gradle.kts (gradle properties) and shows the unread count. */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("demo", MODE_PRIVATE)
        val config = ConversationsConfiguration(
            baseUrl = BuildConfig.CONVERSATIONS_URL,
            token = BuildConfig.CONVERSATIONS_TOKEN,
            deviceId = prefs.getString("device_id", null),
            debug = true,
        )
        setContent {
            var unread by remember { mutableIntStateOf(0) }
            Column(Modifier.fillMaxSize()) {
                Text("Support ($unread unread)")
                ConversationsChat(activity = this@MainActivity, configuration = config, modifier = Modifier.fillMaxSize()) { event ->
                    when (event) {
                        is BridgeEvent.Ready -> prefs.edit().putString("device_id", event.info.deviceId).apply()
                        is BridgeEvent.UnreadCountChanged -> unread = event.count
                        else -> Unit
                    }
                }
            }
        }
    }
}
