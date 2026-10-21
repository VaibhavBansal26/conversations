# conversations-android

A Kotlin library that puts the hosted chat ([docs/MOBILE-BRIDGE.md](../../docs/MOBILE-BRIDGE.md)) into a `WebView` with a typed bridge: `ConversationsChatView` (a `FrameLayout`), a Jetpack Compose wrapper, an `@JavascriptInterface` bridge, a file chooser with an optional camera capture, back-press handling and theme handling.

**Status: scaffold, NOT built and NOT tested.** The machine that wrote this had no Android SDK, no Gradle and no Kotlin compiler, and nothing was downloaded. The code is kept small and conventional and follows the documented Android APIs, but it has never been compiled, its JVM unit tests (`src/test`) have never been run, and it has not run on a device or emulator. Treat the first build as the first review: expect to fix compile errors.

The logic worth testing is in classes that do not touch Android (`Envelope.kt`, `Messages.kt`, `BridgeEndpoint.kt`, `ConversationsConfiguration.kt`), mirrors the Swift SDK's tested state machine, and has JVM unit tests with the same cases.

## Build (when you have the tools)

```bash
cd sdks/android
gradle wrapper            # once; the wrapper is not committed
./gradlew :conversations-android:testDebugUnitTest
./gradlew :conversations-android:assembleRelease      # the AAR
./gradlew :demo:installDebug -PconversationsUrl=https://your-app.example.com -PconversationsToken=cvt_...
```

Android Gradle Plugin 8.5, Kotlin 1.9.24, compileSdk 34, minSdk 24, JDK 17.

## Use

```kotlin
class SupportActivity : ComponentActivity() {
    private lateinit var chat: ConversationsChatView
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        chat = ConversationsChatView(this)
        chat.attach(this)                       // in onCreate: registers the file chooser and back handling
        chat.listener = object : ConversationsChatListener {
            override fun onEvent(event: BridgeEvent) { if (event is BridgeEvent.UnreadCountChanged) badge(event.count) }
            override fun onDeviceId(deviceId: String) { prefs.edit().putString("chat_device_id", deviceId).apply() }
        }
        setContentView(chat)
        chat.load(ConversationsConfiguration(
            baseUrl = "https://your-app.example.com",
            token = "cvt_...",                  // a token with "Hosted chat" switched on
            identity = if (signedIn) VisitorIdentity(externalId = user.id, email = user.email, name = user.name, identityHash = hashFromYourBackend) else null,
            deviceId = prefs.getString("chat_device_id", null),
        ))
    }
    override fun onDestroy() { chat.destroy(); super.onDestroy() }
}
```

Compose: `ConversationsChat(activity = this, configuration = config, modifier = Modifier.fillMaxSize()) { event -> ... }` inside `setContent`.

Commands: `chat.identify(...)`, `chat.send(BridgeCommand.SetLanguage("ja"))`, `chat.reset()` on log-out. Commands sent before `ready` are queued.

## Things you must do

- **Identity hash from your backend**, never computed in the app ([identity verification](../../docs/MOBILE-BRIDGE.md#identity-verification)).
- **Camera is optional:** the library does not request `CAMERA`. Declare `<uses-permission android:name="android.permission.CAMERA"/>` in your app and the attach button also offers "take a photo" (written to the app's cache through the library's `FileProvider`, authority `<applicationId>.conversations.fileprovider`); request the permission at runtime before the user needs it. Without it only the document / photo pickers appear, which need no permission.
- **HTTPS** for the deployment; plain http is only for `10.0.2.2` in development (`usesCleartextTraffic` in the demo).
- **ProGuard / R8:** the library ships `consumer-rules.pro` (keeps the `@JavascriptInterface` methods and the event classes).

## What the wrapper does

`javaScriptEnabled` and `domStorageEnabled` (the page keeps its session in `localStorage`), file and content access off, mixed content blocked, multiple windows routed to the link policy (never a second web view), navigation kept on the chat's origin (everything else goes to `shouldOpenLink`, default `ACTION_VIEW`), bridge messages accepted only while the web view shows the chat's origin, 16 KiB and protocol checks, a 10 s ack timeout, the page's theme set to follow the system night mode, hardware and gesture back offered to the page first (closes the emoji picker) and then to the activity.

## Limits

A backgrounded app is restricted by Doze and app standby: no socket, no events. The page resyncs when the app returns. Notifications while closed need push ([design note](../../docs/MOBILE-API.md#push-notifications-design-note), not implemented).
