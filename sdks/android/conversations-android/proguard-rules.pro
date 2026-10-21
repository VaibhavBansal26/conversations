# Applied automatically to apps that use the library. The bridge object is called from JavaScript by name and by method signature.
-keepclassmembers class com.conversations.chat.ConversationsChatView$JsBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
-keep class com.conversations.chat.BridgeEvent { *; }
-keep class com.conversations.chat.BridgeEvent$* { *; }
