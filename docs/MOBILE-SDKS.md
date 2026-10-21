# Mobile SDKs and integration guides

Native wrappers and guides for the hosted chat ([MOBILE-BRIDGE.md](MOBILE-BRIDGE.md)). They are thin on purpose: the chat is one web page maintained in this repository; the wrappers load it, speak the bridge, and handle the things only native code can (file chooser, permissions, links, back, lifecycle). If you want your own native screens instead, use the [public API](MOBILE-API.md).

No signing keys, store accounts or published packages are involved anywhere. Everything below is labelled with what was actually done.

| Piece | Where | Status |
| --- | --- | --- |
| iOS Swift Package `ConversationsKit` (`ConversationsChatViewController`, SwiftUI `ConversationsChatView`, typed bridge, state machine) | [sdks/ios](../sdks/ios/README.md) | **built and unit tested on macOS** (`swift test`: 24 cases); UIKit and SwiftUI views **compile** for the iOS 14+ Simulator SDK; **scaffold, not device-tested**: never run in a Simulator or on a device (no simulator runtime on the machine) |
| iOS demo app source | [sdks/ios/Examples/iOSDemo](../sdks/ios/Examples/iOSDemo/DemoApp.swift) | type-checks against the iOS build of the package; there is no Xcode project in the repository; not run |
| Android library `conversations-android` (`ConversationsChatView`, Compose wrapper, `@JavascriptInterface` bridge, file chooser, back press, ProGuard rules) | [sdks/android](../sdks/android/README.md) | **scaffold, not built, not tested**: no Android SDK, Gradle or Kotlin compiler was available; the JVM unit tests exist but were never run |
| Android demo app | [sdks/android/Examples/AndroidDemo](../sdks/android/Examples/AndroidDemo/build.gradle.kts) | not built |
| React Native guide | [sdks/react-native](../sdks/react-native/README.md) | documentation only, snippet not compiled |
| Flutter guide | [sdks/flutter](../sdks/flutter/README.md) | documentation only, snippet not compiled |
| the bridge itself (what both native SDKs speak) | [bridge.js](../server/public/chat/bridge.js), [schemas](bridge/envelope.schema.json) | tested: jsdom contract tests, Chromium conformance page, Playwright |

## What is shared

All wrappers implement the same state machine, which is why the Swift and Kotlin sources mirror each other test for test:

1. Load `<PUBLIC_URL>/chat?token=...&bridge=<ios|android|rn|flutter>` and register the native message channel before the page loads.
2. Queue commands until the page's `ready` event; flush them in order on `ready`; go back to queueing when the page is reloaded.
3. Match `ack` to commands by `reply_to`; fail commands that get no ack in 10 seconds.
4. Validate every inbound envelope (16 KiB, protocol version 1, shape) and ignore anything else; never reply to another protocol version.
5. Answer `link_clicked` with `ack {ok: true, handled}` after offering the validated URL (https, mailto, tel) to the app.
6. Keep the web view on the chat's origin; route everything else and `window.open` to the link policy.
7. Never expose tokens or session ids: the bridge does not carry them.

## What each platform needs from your app

| | iOS | Android |
| --- | --- | --- |
| attach button (camera, photos, files) | `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription` in Info.plist | none for the pickers; `CAMERA` permission (declared and requested by you) adds "take a photo" |
| plain http during development | App Transport Security local networking exception | `usesCleartextTraffic` for `10.0.2.2` |
| back | `chat.handleBack { handled in ... }` | `chat.attach(activity)` wires `OnBackPressedDispatcher` |
| dark mode | the page follows `prefers-color-scheme`; or force with `theme` | the library sends `setTheme` from the system night mode |
| log-out | `chat.reset()` | `chat.reset()` |
| identity | hash from your backend into `VisitorIdentity.identityHash` | same |

## What no wrapper can do

- Receive anything while the app is suspended or Doze-restricted. A web view is part of the app process. For "you have a reply" while the app is closed you need push, which is a [design note](MOBILE-API.md#push-notifications-design-note) and not implemented.
- Verify a user's identity. Only your backend holds the identity secret ([identity verification](MOBILE-BRIDGE.md#identity-verification)).

## Known gaps

- Nothing has run in `WKWebView` or Android `WebView`; engine differences (keyboard resize, file chooser, storage eviction, process termination) are handled by design and need a device pass. Run `/chat/bridge-test` in a desktop browser to validate the page against your deployment (it tests the page and the bridge protocol over the iframe transport, not your native glue); to test the native glue, log every event in your delegate or listener and exercise each command by hand.
- No Xcode project, no Gradle wrapper and no CI job build the SDKs; the iOS package is built by hand with the commands in its README.
- Distribution (CocoaPods, Maven Central, pub.dev, npm) is intentionally not done.
