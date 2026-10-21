# ConversationsKit (iOS)

A thin Swift Package that puts the hosted chat ([docs/MOBILE-BRIDGE.md](../../docs/MOBILE-BRIDGE.md)) into a `WKWebView` with a typed bridge.

**Status: scaffold, not device-tested.** What was actually done on a Mac with Xcode 16.3 (Swift 6.1):

| Check | Result |
| --- | --- |
| `swift build` and `swift test` (macOS) | passes, 24 XCTest cases for the envelope, commands, events, state machine, URL builder (the bridge and state machine are plain Swift) |
| UIKit and SwiftUI views for iOS 14+ | compile for the iOS Simulator SDK (`swift build --sdk $(xcrun --sdk iphonesimulator --show-sdk-path) --triple arm64-apple-ios14.0-simulator`) |
| `Examples/iOSDemo/DemoApp.swift` | type-checks against the iOS-simulator build of the package |
| run in an iOS Simulator or on a device | **not done**: the Mac had the iOS 18.4 SDK but no simulator runtime or device, so `WKWebView` behaviour (file chooser, keyboard, background, process termination) is untested |

No signing identity, store account or published package is involved.

## Install

Swift Package Manager: add the package (path `sdks/ios` of this repository, or a Git URL you host) and the product `ConversationsKit`. iOS 14+.

## Use (UIKit)

```swift
import ConversationsKit

let config = ConversationsConfiguration(
    baseURL: URL(string: "https://your-app.example.com")!,
    token: "cvt_...",                    // a token with "Hosted chat" switched on
    identity: signedIn ? VisitorIdentity(externalId: user.id, email: user.email, name: user.name, identityHash: hashFromYourBackend) : nil,
    locale: Locale.current.identifier,
    deviceId: UserDefaults.standard.string(forKey: "chatDeviceId")
)
let chat = ConversationsChatViewController(configuration: config)
chat.delegate = self        // ConversationsChatDelegate: every method has a default
navigationController?.pushViewController(chat, animated: true)
```

Delegate highlights: `didReceive event` (all events), `unreadCountDidChange`, `shouldOpen url` (return true if you opened the link; the default opens it with `UIApplication.open`), `didReceiveDeviceId` (persist it), `didFailWith` (show your own error screen), `chatDidRequestClose`.

Commands: `chat.identify(...)`, `chat.send(.setLanguage(locale: "ja"))`, `chat.send(.setCustomAttributes(["plan": .string("pro")]))`, `chat.reset()` on log-out, `chat.handleBack { handled in if !handled { pop } }`. Commands sent before the page is ready are queued and flushed on `ready`.

## Use (SwiftUI)

```swift
ConversationsChatView(configuration: config) { event in
    if case .unreadCountChanged(let n) = event { unread = n }
}
```

## Things you must do

- **Info.plist:** `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription` (see `Examples/iOSDemo/Info.plist.snippet.xml`). The attach button uses an HTML file input, which iOS turns into its own camera / library / files sheet; without the keys the app is terminated when the user picks the camera.
- **The identity hash comes from your backend**, never computed in the app ([identity verification](../../docs/MOBILE-BRIDGE.md#identity-verification)). Pass it with `external_id` and `email` after sign-in; call `chat.reset()` on log-out.
- **HTTPS** for the deployment (`PUBLIC_URL`); App Transport Security blocks plain http except local networking in development.

## What the wrapper does for you

- Registers the `conversations` script message handler through a weak proxy: `WKUserContentController` retains its handlers, so handing it the controller would be a retain cycle; the handler is also removed in `deinit`.
- Accepts script messages only from the main frame on the chat's origin, validates every envelope (16 KiB, protocol version, shape) and every link (https, mailto, tel).
- Keeps the web view on the chat's origin: other navigations are cancelled and offered to `shouldOpen`; `window.open` never creates a second web view.
- Restarts the page when iOS kills its web content process; reports `reload` to the state machine so queued commands wait for the new `ready`.
- Fails commands that get no ack within 10 s (`BridgeError.timedOut`).

## Limits

A suspended app receives nothing: no events and no socket while in the background. Resync happens by itself when the app returns. For notifications while the app is closed see the push [design note](../../docs/MOBILE-API.md#push-notifications-design-note) (not implemented), or use the [public API](../../docs/MOBILE-API.md) with your own push.

## Demo

`Examples/iOSDemo/DemoApp.swift` is a SwiftUI app that opens the chat for a URL and token typed on a form (or launch arguments). There is no `.xcodeproj` in the repository (no signing, no generated project files): in Xcode create an iOS App, add this package as a local dependency, replace the app file with `DemoApp.swift`, and merge `Info.plist.snippet.xml`.

## Tests

```bash
cd sdks/ios && swift test
```
