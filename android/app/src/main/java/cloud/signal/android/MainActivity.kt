package cloud.signal.android

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.MimeTypeMap
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var webView: WebView? = null
    private lateinit var progress: ProgressBar
    private lateinit var errorPanel: LinearLayout
    private lateinit var errorText: TextView
    private lateinit var updateWebView: Button
    private lateinit var updater: AppUpdates
    private lateinit var chatTransport: NativeChatTransport
    private var reply: JavaScriptReplyProxy? = null
    private var bridgeReady = false
    private var destroyed = false
    private val invitation = Regex("[A-Za-z0-9_-]{32}")
    private val bundledWebFiles by lazy { bundledFiles("web").map { "/" + it.removePrefix("web/") }.toSet() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        updater = AppUpdates(this, scope)
        updater.restoreState(savedInstanceState)
        chatTransport = NativeChatTransport(scope) { data -> sendNativeMessage(data) }
        val root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(23, 24, 33)) }
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100 }
        root.addView(progress, FrameLayout.LayoutParams(-1, dp(3)))
        errorPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER
            setPadding(dp(30), dp(30), dp(30), dp(30))
            setBackgroundColor(Color.rgb(23, 24, 33))
            visibility = View.GONE
        }
        errorText = TextView(this).apply { setTextColor(Color.rgb(220, 228, 238)); textSize = 17f; gravity = android.view.Gravity.CENTER }
        errorPanel.addView(errorText, LinearLayout.LayoutParams(-1, -2))
        errorPanel.addView(Button(this).apply {
            text = "Повторить подключение"
            setOnClickListener {
                errorPanel.visibility = View.GONE
                if (bridgeReady) webView?.loadUrl(SignalApi.SERVER_ORIGIN + "/") ?: recreate() else recreate()
            }
        }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(20) })
        updateWebView = Button(this).apply {
            text = "Обновить WebView / Chrome"
            visibility = View.GONE
            setOnClickListener { openWebViewUpdate() }
        }
        errorPanel.addView(updateWebView, LinearLayout.LayoutParams(-2, -2))
        root.addView(errorPanel, FrameLayout.LayoutParams(-1, -1))
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            insets
        }
        setContentView(root)
        val content = try {
            WebView(this).apply {
                setBackgroundColor(Color.rgb(23, 24, 33))
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
                settings.javaScriptCanOpenWindowsAutomatically = false
                settings.setSupportMultipleWindows(false)
                settings.setGeolocationEnabled(false)
                // AndroidX also enables Safe Browsing on compatible providers
                // running on Android versions before the framework API exists.
                if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) WebSettingsCompat.setSafeBrowsingEnabled(settings, true)
                settings.userAgentString = "${settings.userAgentString} SignalAndroid/${BuildConfig.VERSION_NAME}"
                CookieManager.getInstance().setAcceptCookie(true)
                CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
            }
        } catch (_: Exception) {
            showWebViewError("Android не удалось открыть окно переписки. Включите или обновите Android System WebView либо Chrome в настройках устройства.")
            return
        }
        webView = content
        root.addView(content, 0, FrameLayout.LayoutParams(-1, -1))
        content.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress == 100) View.GONE else View.VISIBLE
            }
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
        }
        content.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest): WebResourceResponse? = bundledResponse(request)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (trusted(request.url)) return false
                if (request.isForMainFrame) external(request.url)
                return true
            }
            @Suppress("DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                // Android 6 uses the String overload, including when following
                // invitation links. Keep the same navigation origin policy.
                val uri = Uri.parse(url)
                if (trusted(uri)) return false
                external(uri)
                return true
            }
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) { reply = null; chatTransport.reset() }
            override fun onPageFinished(view: WebView?, url: String?) { CookieManager.getInstance().flush() }
            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler, error: SslError?) {
                handler.cancel()
                showError("Не удалось проверить защищённое подключение к серверу. Проверьте дату на устройстве и повторите позже.")
            }
            override fun onReceivedError(view: WebView?, request: WebResourceRequest, error: WebResourceError?) {
                if (request.isForMainFrame) showError("Сервер пока недоступен. Проверьте интернет и повторите подключение.")
            }
            @Suppress("DEPRECATION")
            override fun onReceivedError(view: WebView?, errorCode: Int, description: String?, failingUrl: String?) {
                // The legacy callback only reports the main document.
                showError("Не удалось открыть переписку. Проверьте подключение и повторите попытку.")
            }
            override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest, errorResponse: WebResourceResponse?) {
                if (request.isForMainFrame) showError("Сервер временно не отвечает. Повторите подключение через несколько секунд.")
            }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // A low-memory WebView restart must not terminate the native call.
                if (webView === view) { webView = null; reply = null; bridgeReady = false }
                chatTransport.reset()
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                showError("Окно переписки было выгружено Android. Звонок продолжает работать. Нажмите «Повторить подключение», чтобы открыть переписку.")
                return true
            }
        }
        val chromeVersion = Regex("(?:Chrome|Chromium)/(\\d+)").find(content.settings.userAgentString)?.groupValues?.get(1)?.toIntOrNull()
        if (chromeVersion != null && chromeVersion < 94) {
            showWebViewError("Обновите Android System WebView или Chrome в магазине приложений, чтобы открыть Сигнал. Нужна версия 94 или новее для переписки и защищённого подключения к звонкам.")
            return
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            showWebViewError("Обновите Android System WebView или Chrome в магазине приложений, чтобы открыть Сигнал. Нужна поддержка защищённого подключения переписки к звонкам.")
            return
        }
        WebViewCompat.addWebMessageListener(content, "signalAndroidBridge", setOf(SignalApi.SERVER_ORIGIN)) { _, message, sourceOrigin, isMainFrame, proxy ->
            if (destroyed || !isMainFrame || !trusted(sourceOrigin)) return@addWebMessageListener
            val text = runCatching { message.data }.getOrNull() ?: return@addWebMessageListener
            if (text.length > 32_768) return@addWebMessageListener
            val data = runCatching { JSONObject(text) }.getOrNull() ?: return@addWebMessageListener
            reply = proxy
            when (data.optString("type")) {
                "openCall" -> {
                    val id = data.optString("channelId")
                    val name = data.optString("channelName").take(40).filter { !it.isISOControl() }
                    if (!SignalApi.validChannelId(id)) return@addWebMessageListener
                    try {
                        startActivity(Intent(this, CallActivity::class.java).putExtra("channelId", id).putExtra("channelName", name.ifBlank { "Канал" }))
                        if (CallService.activeState.value.phase in setOf("connected", "connecting", "reconnecting")) sendCallState()
                        else sendNativeMessage(JSONObject().put("type", "callState").put("state", "connecting").put("channelId", id))
                    } catch (_: Exception) {
                        sendNativeMessage(JSONObject().put("type", "callState").put("state", "error").put("channelId", id).put("error", "Не удалось открыть звонок. Повторите попытку."))
                    }
                }
                "leaveCall" -> {
                    // A normal start command reaches the existing foreground
                    // call; it never starts a new capture service from WebView.
                    if (CallService.activeState.value.channelId != null) startService(Intent(this, CallService::class.java).setAction(CallService.ACTION_LEAVE))
                    sendCallState()
                }
                "getCallState" -> sendCallState(data.optString("requestId").takeIf { it.length in 1..120 })
                "checkUpdate" -> updater.check()
                else -> chatTransport.onMessage(data)
            }
        }
        bridgeReady = true
        scope.launch { CallService.activeState.collect { sendCallState() } }
        val restored = savedInstanceState != null && content.restoreState(savedInstanceState) != null
        val deepLink = inviteUrl(intent?.data)
        if (deepLink != null) content.loadUrl(deepLink)
        else if (!restored || !trusted(Uri.parse(content.url.orEmpty()))) content.loadUrl(SignalApi.SERVER_ORIGIN + "/")
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) { override fun handleOnBackPressed() { goBack() } })
    }

    private fun trusted(uri: Uri): Boolean = uri.scheme == "https" && uri.host == "13.143.172.92" && uri.port == 9443 && uri.userInfo == null

    private fun bundledFiles(folder: String): List<String> = assets.list(folder).orEmpty().flatMap { child ->
        val path = "$folder/$child"
        if (assets.list(path).orEmpty().isNotEmpty()) bundledFiles(path) else listOf(path)
    }

    private fun bundledResponse(request: WebResourceRequest): WebResourceResponse? {
        if (request.method != "GET" || !trusted(request.url)) return null
        val path = request.url.path ?: return null
        val file = if (path == "/") "/index.html" else path
        // Only files shipped in this APK may be served locally. The API, media
        // signalling, downloads and every other server route stay on the network.
        if (file != "/index.html" && file != "/signal.svg" && !file.startsWith("/assets/")) return null
        if (file !in bundledWebFiles) return null
        val mime = when (file.substringAfterLast('.').lowercase()) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "svg" -> "image/svg+xml"
            "json" -> "application/json"
            else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.substringAfterLast('.').lowercase()) ?: "application/octet-stream"
        }
        val encoding = if (mime.startsWith("text/") || mime == "image/svg+xml" || mime == "application/json") "utf-8" else null
        return runCatching {
            WebResourceResponse(mime, encoding, 200, "OK", mapOf(
                "Cache-Control" to "no-store",
                "X-Content-Type-Options" to "nosniff",
                "Referrer-Policy" to "same-origin",
                "Content-Security-Policy" to "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss://13.143.172.92:9443; worker-src 'self' blob:; object-src 'none'",
            ), assets.open("web$file"))
        }.getOrNull()
    }

    private fun inviteUrl(uri: Uri?): String? {
        if (uri == null) return null
        val code = if (uri.scheme == "signal" && uri.host == "invite") uri.path?.removePrefix("/") else if (trusted(uri)) uri.getQueryParameter("invite") else null
        return code?.takeIf { invitation.matches(it) }?.let { SignalApi.SERVER_ORIGIN + "/?invite=" + Uri.encode(it) }
    }

    private fun external(uri: Uri) {
        inviteUrl(uri)?.let { webView?.loadUrl(it); return }
        if (uri.scheme != "https" && uri.scheme != "http") return
        try { startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)) }
        catch (_: Exception) { Toast.makeText(this, "Не удалось открыть браузер.", Toast.LENGTH_SHORT).show() }
    }

    private fun sendCallState(requestId: String? = null) {
        if (destroyed) return
        val current = CallService.activeState.value
        val state = when (current.phase) {
            "connecting", "connected", "reconnecting", "error" -> current.phase
            "ended" -> "disconnected"
            else -> "idle"
        }
        val data = JSONObject().put("type", "callState").put("state", state)
        requestId?.let { data.put("requestId", it) }
        current.channelId?.let { data.put("channelId", it) }
        if (state == "error") data.put("error", current.error?.take(300)?.filter { !it.isISOControl() } ?: "Не удалось подключиться к звонку. Откройте комнату и повторите попытку.")
        sendNativeMessage(data)
    }

    private fun sendNativeMessage(data: JSONObject) {
        if (destroyed || !bridgeReady || !trusted(Uri.parse(webView?.url.orEmpty()))) return
        val proxy = reply ?: return
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            try { proxy.postMessage(data.toString()) }
            catch (_: Exception) { /* A reply can expire while its document navigates. */ }
        }
    }

    private fun showError(message: String) { errorText.text = message; errorPanel.visibility = View.VISIBLE; progress.visibility = View.GONE }
    private fun showWebViewError(message: String) { showError(message); updateWebView.visibility = View.VISIBLE }
    private fun openWebViewUpdate() {
        val provider = runCatching { WebViewCompat.getCurrentWebViewPackage(this)?.packageName }.getOrNull()
            ?: "com.google.android.webview"
        val packageName = if (Regex("[A-Za-z0-9_.]+").matches(provider)) provider else "com.google.android.webview"
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$packageName")))
        } catch (_: Exception) {
            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$packageName"))) }
            catch (_: Exception) { Toast.makeText(this, "Откройте магазин приложений и обновите Android System WebView или Chrome.", Toast.LENGTH_LONG).show() }
        }
    }
    private fun goBack() { val content = webView; if (content?.canGoBack() == true) content.goBack() else moveTaskToBack(true) }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); inviteUrl(intent.data)?.let { errorPanel.visibility = View.GONE; if (bridgeReady) webView?.loadUrl(it) ?: recreate() else recreate() } }
    override fun onResume() { super.onResume(); if (::updater.isInitialized) updater.onResume(); sendCallState() }
    override fun onPause() { runCatching { CookieManager.getInstance().flush() }; super.onPause() }
    override fun onSaveInstanceState(outState: Bundle) { webView?.saveState(outState); updater.saveState(outState); super.onSaveInstanceState(outState) }
    override fun onDestroy() {
        destroyed = true
        reply = null
        if (::updater.isInitialized) updater.close()
        if (::chatTransport.isInitialized) chatTransport.close()
        scope.cancel()
        webView?.let { (it.parent as? ViewGroup)?.removeView(it); it.destroy() }
        webView = null
        super.onDestroy()
    }
}
