# Flutter integration guide

**Status: documentation only. Nothing here was compiled or run** (no Flutter SDK on the machine that wrote this; there is no published package). The snippet follows the documented `webview_flutter` API (`JavaScriptChannel`, `NavigationDelegate`, `runJavaScript`) and the bridge in [docs/MOBILE-BRIDGE.md](../../docs/MOBILE-BRIDGE.md).

Use `bridge=flutter`: the page sends JSON text through a JavaScript channel named exactly `ConversationsFlutter`, and you answer with `runJavaScript`.

```dart
// pubspec.yaml: webview_flutter: ^4.9.0
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

const base = 'https://your-app.example.com'; // PUBLIC_URL, https
const token = 'cvt_...'; // a token with "Hosted chat" switched on

class SupportChat extends StatefulWidget {
  const SupportChat({super.key, this.identity = const {}, this.deviceId, this.onUnread, this.onDeviceId});
  final Map<String, String> identity; // external_id, email, name, identity_hash: the hash comes from YOUR backend
  final String? deviceId;
  final void Function(int)? onUnread;
  final void Function(String)? onDeviceId;
  @override
  State<SupportChat> createState() => _SupportChatState();
}

class _SupportChatState extends State<SupportChat> {
  late final WebViewController c;
  bool ready = false;
  final queue = <String>[];

  // an envelope as a JavaScript string literal (JSON escaping plus the two line separators)
  String receive(String text) => 'window.ConversationsBridge && window.ConversationsBridge.receive(${jsonEncode(text).replaceAll(' ', r' ').replaceAll(' ', r' ')});';

  void send(String type, [Map<String, Object?> payload = const {}, String? replyTo]) {
    final env = jsonEncode({'v': 1, 'id': DateTime.now().microsecondsSinceEpoch.toString(), 'type': type, 'payload': payload, if (replyTo != null) 'reply_to': replyTo});
    if (!ready && type != 'ack') { queue.add(env); return; } // commands wait for `ready`
    c.runJavaScript(receive(env));
  }

  @override
  void initState() {
    super.initState();
    final uri = Uri.parse('$base/chat').replace(queryParameters: {'token': token, 'bridge': 'flutter', if (widget.deviceId != null) 'device_id': widget.deviceId!, ...widget.identity});
    c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel('ConversationsFlutter', onMessageReceived: (m) {
        final Map<String, dynamic> msg;
        try { msg = jsonDecode(m.message) as Map<String, dynamic>; } catch (_) { return; }
        if (msg['v'] != 1 || msg['id'] is! String) return; // other versions are ignored
        final p = (msg['payload'] ?? {}) as Map<String, dynamic>;
        switch (msg['type']) {
          case 'ready':
            ready = true;
            widget.onDeviceId?.call(p['device_id'] as String);
            widget.onUnread?.call(p['unread_count'] as int);
            for (final e in queue) { c.runJavaScript(receive(e)); }
            queue.clear();
          case 'unread_count_changed':
            widget.onUnread?.call(p['count'] as int);
          case 'link_clicked':
            final url = Uri.tryParse(p['url'] as String);
            if (url != null && {'https', 'mailto', 'tel'}.contains(url.scheme)) launchUrl(url, mode: LaunchMode.externalApplication);
            send('ack', {'ok': true, 'handled': true}, msg['id'] as String);
        }
      })
      ..setNavigationDelegate(NavigationDelegate(
        // stay on the chat's origin; anything else opens in the system
        onNavigationRequest: (r) => r.url.startsWith(base) ? NavigationDecision.navigate : NavigationDecision.prevent,
      ))
      ..loadRequest(uri);
  }

  @override
  Widget build(BuildContext context) => SafeArea(child: WebViewWidget(controller: c));
}
```

After sign-in call `send('identify', {...})`, on log-out `send('reset')`, `send('setLanguage', {'locale': 'es'})`. The full command and event list is in [docs/MOBILE-BRIDGE.md](../../docs/MOBILE-BRIDGE.md#the-bridge-protocol-v1).

Platform notes (from documentation, untested here): on Android, `webview_flutter_android` needs `setOnShowFileSelector` for the attach button's file chooser (and the `CAMERA` permission if you want a camera choice); on iOS add `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription`; a backgrounded app receives no events; compute the identity hash on your server; use https.
