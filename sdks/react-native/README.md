# React Native integration guide

**Status: documentation only. Nothing here was compiled or run** (no Node project with `react-native-webview` was created; there is no published package). The snippet follows the documented `react-native-webview` API (`onMessage`, `injectJavaScript`, `onShouldStartLoadWithRequest`) and the bridge in [docs/MOBILE-BRIDGE.md](../../docs/MOBILE-BRIDGE.md); the bridge itself is tested in Chromium and with contract tests, the React Native glue is not.

Install `react-native-webview` and use `bridge=rn`: the page sends JSON text through `window.ReactNativeWebView.postMessage`, and you answer through `injectJavaScript`.

```tsx
import React, { useCallback, useMemo, useRef, useState } from "react";
import { Linking, SafeAreaView } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

const BASE = "https://your-app.example.com"; // PUBLIC_URL of the deployment, https
const TOKEN = "cvt_..."; // a token with "Hosted chat" switched on (public by design)

const ORIGIN = new URL(BASE).origin;
const SAFE = /^(https:|mailto:|tel:)/;

// the text of an envelope as a JavaScript string literal (JSON escaping plus the two line separators)
const receiveScript = (text: string) =>
  `window.ConversationsBridge && window.ConversationsBridge.receive(${JSON.stringify(text).replace(/ /g, "\\u2028").replace(/ /g, "\\u2029")}); true;`;

export type Identity = { external_id?: string; email?: string; name?: string; identity_hash?: string };

export function SupportChat({ identity, deviceId, onUnread, onDeviceId }: {
  identity?: Identity; // identity_hash must come from YOUR backend (never compute it here)
  deviceId?: string;
  onUnread?: (n: number) => void;
  onDeviceId?: (id: string) => void;
}) {
  const web = useRef<WebView>(null);
  const [ready, setReady] = useState(false);

  const uri = useMemo(() => {
    const q = new URLSearchParams({ token: TOKEN, bridge: "rn", ...(deviceId ? { device_id: deviceId } : {}), ...(identity as Record<string, string> | undefined) });
    return `${BASE}/chat?${q.toString()}`;
  }, [deviceId, identity]);

  const send = useCallback((type: string, payload: object = {}, replyTo?: string) => {
    const env = { v: 1, id: Math.random().toString(36).slice(2), type, payload, ...(replyTo ? { reply_to: replyTo } : {}) };
    web.current?.injectJavaScript(receiveScript(JSON.stringify(env)));
  }, []);

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    let m: { v?: number; id?: string; type?: string; payload?: any };
    try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (m.v !== 1 || typeof m.id !== "string") return; // other versions are ignored
    switch (m.type) {
      case "ready": setReady(true); onDeviceId?.(m.payload.device_id); onUnread?.(m.payload.unread_count); break;
      case "unread_count_changed": onUnread?.(m.payload.count); break;
      case "link_clicked":
        if (SAFE.test(m.payload.url)) void Linking.openURL(m.payload.url);
        send("ack", { ok: true, handled: true }, m.id); // tells the page we opened it
        break;
      case "close_requested": /* navigation.goBack() */ break;
      case "error": if (m.payload.fatal) setReady(false); break;
    }
  }, [onDeviceId, onUnread, send]);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <WebView
        ref={web}
        source={{ uri }}
        originWhitelist={[ORIGIN]}
        onMessage={onMessage}
        // stay on the chat's origin; anything else opens in the system
        onShouldStartLoadWithRequest={(req) => req.url.startsWith(ORIGIN) || (SAFE.test(req.url) && (void Linking.openURL(req.url), false))}
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        allowsInlineMediaPlayback
      />
    </SafeAreaView>
  );
}
```

Use `send("identify", {...})` after sign-in, `send("reset")` on log-out, `send("setLanguage", { locale: "es" })`. Hold commands until the `ready` event arrives (the guard in `receiveScript` silently drops anything sent while the page is still loading), then send them; the `ready` flag above is for that. The command and event list is in [docs/MOBILE-BRIDGE.md](../../docs/MOBILE-BRIDGE.md#the-bridge-protocol-v1).

Platform notes (from the library's documentation, untested here): file inputs work on both platforms when the app declares the camera and photo permissions (iOS Info.plist keys `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription`; Android `CAMERA` if you want the camera choice); a backgrounded app receives no events; the identity hash is computed on your server; use https for the deployment.
