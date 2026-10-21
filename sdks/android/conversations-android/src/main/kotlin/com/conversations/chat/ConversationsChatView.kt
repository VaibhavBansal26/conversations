package com.conversations.chat

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.provider.MediaStore
import android.util.AttributeSet
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import java.io.File

/** Receives events and makes the decisions only the app can make. Every method has a safe default. */
interface ConversationsChatListener {
    /** Every bridge event, on the main thread. */
    fun onEvent(event: BridgeEvent) {}

    /** A visitor tapped a link (already validated: https, mailto or tel). Return true if you opened it. Default: an ACTION_VIEW intent. */
    fun shouldOpenLink(url: String, source: LinkSource): Boolean = false

    /** The page reported a device id. Persist it (it is not a credential) and pass it back in [ConversationsConfiguration.deviceId] next launch. */
    fun onDeviceId(deviceId: String) {}
}

/**
 * The hosted chat in a [WebView], as a [FrameLayout]. Scaffold, not device-tested: the code is written against the documented Android APIs and
 * the bridge logic is covered by JVM unit tests, but it has not been built or run on a device or emulator.
 *
 * Usage from an activity (`ComponentActivity`): create the view, call [attach] in `onCreate` (it registers the file chooser result and the back
 * handling, which must happen before the activity is started), then [load].
 */
class ConversationsChatView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : FrameLayout(context, attrs) {
    var listener: ConversationsChatListener? = null
    var configuration: ConversationsConfiguration? = null
        private set
    val unreadCount: Int get() = endpoint.unreadCount

    private val main = Handler(Looper.getMainLooper())
    private val webView: WebView = WebView(context)
    private val endpoint = BridgeEndpoint(transport = { text -> main.post { webView.evaluateJavascript(bridgeReceiveScript(text), null) } })
    private val expiry = object : Runnable {
        override fun run() { endpoint.expirePending(10_000); main.postDelayed(this, 2_000) }
    }

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var cameraUri: Uri? = null
    private var launcher: ActivityResultLauncher<Intent>? = null
    private var activity: ComponentActivity? = null
    private var backCallback: OnBackPressedCallback? = null

    init {
        addView(webView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        configureWebView()
        endpoint.linkHandler = { url, source -> listener?.shouldOpenLink(url, source) == true || openExternally(url) }
        endpoint.onEvent = { event -> handle(event) }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true            // the chat is a web app
            domStorageEnabled = true            // localStorage keeps the session between launches
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(true)     // window.open is routed to the link policy, never a second web view
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
        }
        webView.addJavascriptInterface(JsBridge(), "ConversationsAndroid")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                val cfg = configuration ?: return true
                if (cfg.isSameOrigin(url)) return false
                LinkPolicy.validated(url)?.let { safe -> if (listener?.shouldOpenLink(safe, LinkSource.MESSAGE) != true) openExternally(safe) }
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) { if (configuration?.isSameOrigin(url) == true) endpoint.reload() }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                // the new window's first URL is read through a throw-away web view, then handed to the link policy
                val probe = WebView(view.context)
                probe.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                        LinkPolicy.validated(request.url.toString())?.let { safe -> if (listener?.shouldOpenLink(safe, LinkSource.MESSAGE) != true) openExternally(safe) }
                        main.post { v.destroy() }
                        return true
                    }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = probe
                resultMsg.sendToTarget()
                return true
            }

            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                return showFileChooser(callback, params)
            }
        }
    }

    /**
     * Call once from `onCreate` of the hosting activity: registers the file chooser and the back-press handling (hardware or gesture back first
     * closes the emoji picker inside the chat; when the page has nothing to close the activity's normal back handling continues).
     */
    fun attach(activity: ComponentActivity) {
        this.activity = activity
        launcher = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result -> onChooserResult(result.resultCode, result.data) }
        val cb = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                send(BridgeCommand.Back) { r ->
                    val handled = r.getOrNull()?.handled == true
                    if (!handled) { isEnabled = false; activity.onBackPressedDispatcher.onBackPressed(); isEnabled = true }
                }
            }
        }
        backCallback = cb
        activity.onBackPressedDispatcher.addCallback(activity, cb)
    }

    /** Load (or reload with a new configuration, e.g. after sign-in). */
    fun load(configuration: ConversationsConfiguration) {
        this.configuration = configuration
        WebView.setWebContentsDebuggingEnabled(configuration.debug)
        endpoint.reload()
        webView.loadUrl(configuration.chatUrl())
    }

    fun send(command: BridgeCommand, completion: (Result<BridgeAck>) -> Unit = {}) = endpoint.send(command, completion)
    fun identify(identity: VisitorIdentity) = send(BridgeCommand.Identify(identity))

    /** Log the visitor out of the chat (ends the server session, forgets local data). */
    fun reset() = send(BridgeCommand.Reset)

    override fun onAttachedToWindow() { super.onAttachedToWindow(); main.postDelayed(expiry, 2_000) }
    override fun onDetachedFromWindow() { main.removeCallbacks(expiry); super.onDetachedFromWindow() }

    /** Free the web view when the screen is finished (call from `onDestroy`). */
    fun destroy() {
        main.removeCallbacksAndMessages(null)
        backCallback?.remove()
        webView.removeJavascriptInterface("ConversationsAndroid")
        removeView(webView)
        webView.destroy()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // with the theme left on AUTO the page is told explicitly, because a web view does not always follow the app's night mode
        if (configuration?.theme == Theme.AUTO) send(BridgeCommand.SetTheme(if (isNight(newConfig)) Theme.DARK else Theme.LIGHT))
    }

    private fun isNight(c: Configuration) = (c.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    private fun handle(event: BridgeEvent) {
        if (event is BridgeEvent.Ready) {
            listener?.onDeviceId(event.info.deviceId)
            if (configuration?.theme == Theme.AUTO) send(BridgeCommand.SetTheme(if (isNight(resources.configuration)) Theme.DARK else Theme.LIGHT))
        }
        listener?.onEvent(event)
    }

    private fun openExternally(url: String): Boolean = try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (e: Exception) {
        false
    }

    // ---- attachments: system picker plus an optional camera capture (the camera choice appears only when the app declares the CAMERA permission) ----

    private fun showFileChooser(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        val act = activity ?: return false.also { callback.onReceiveValue(null) }
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        val pick = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("image/*", "application/pdf"))
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE)
        }
        val chooser = Intent.createChooser(pick, null)
        if (cameraDeclared(act)) {
            val file = File(File(act.cacheDir, "conversations").apply { mkdirs() }, "capture-${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(act, "${act.packageName}.conversations.fileprovider", file)
            cameraUri = uri
            val camera = Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, uri).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(camera))
        }
        return try {
            launcher?.launch(chooser)
            listener?.onEvent(BridgeEvent.AttachmentRequested(listOf("image", "pdf")))
            true
        } catch (e: Exception) {
            fileCallback = null
            callback.onReceiveValue(null)
            false
        }
    }

    private fun cameraDeclared(act: Activity): Boolean = try {
        val info = act.packageManager.getPackageInfo(act.packageName, android.content.pm.PackageManager.GET_PERMISSIONS)
        info.requestedPermissions?.contains(android.Manifest.permission.CAMERA) == true
    } catch (e: Exception) {
        false
    }

    private fun onChooserResult(resultCode: Int, data: Intent?) {
        val cb = fileCallback ?: return
        fileCallback = null
        if (resultCode != Activity.RESULT_OK) { cb.onReceiveValue(null); return }
        val picked: Array<Uri>? = when {
            data?.clipData != null -> data.clipData!!.let { c -> Array(c.itemCount) { c.getItemAt(it).uri } }
            data?.data != null -> arrayOf(data.data!!)
            cameraUri != null -> arrayOf(cameraUri!!) // the camera app wrote the file we gave it and returned no data
            else -> null
        }
        cb.onReceiveValue(picked)
    }

    /** Called by the page on the JavaBridge thread: hop to the main thread, then accept the text only from the chat's own origin. */
    inner class JsBridge {
        @JavascriptInterface
        fun postMessage(text: String) {
            main.post {
                val cfg = configuration ?: return@post
                if (!cfg.isSameOrigin(webView.url ?: "")) return@post
                endpoint.receive(text)
            }
        }
    }
}
