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
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
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
    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private lateinit var errorPanel: LinearLayout
    private lateinit var errorText: TextView
    private lateinit var updater: AppUpdates
    private var reply: JavaScriptReplyProxy? = null
    private var destroyed = false
    private val invitation = Regex("[A-Za-z0-9_-]{32}")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        updater = AppUpdates(this, scope)
        val root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(23, 24, 33)) }
        webView = WebView(this).apply {
            setBackgroundColor(Color.rgb(23, 24, 33))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)
            settings.setGeolocationEnabled(false)
            settings.safeBrowsingEnabled = true
            settings.userAgentString = "${settings.userAgentString} SignalAndroid/${BuildConfig.VERSION_NAME}"
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
        }
        root.addView(webView, FrameLayout.LayoutParams(-1, -1))
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
            setOnClickListener { errorPanel.visibility = View.GONE; webView.loadUrl(SignalApi.SERVER_ORIGIN + "/") }
        }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(20) })
        root.addView(errorPanel, FrameLayout.LayoutParams(-1, -1))
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            insets
        }
        setContentView(root)
        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress == 100) View.GONE else View.VISIBLE
            }
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (trusted(request.url)) return false
                if (request.isForMainFrame) external(request.url)
                return true
            }
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) { reply = null }
            override fun onPageFinished(view: WebView?, url: String?) { CookieManager.getInstance().flush() }
            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler, error: SslError?) {
                handler.cancel()
                showError("Не удалось проверить защищённое подключение к серверу. Проверьте дату на устройстве и повторите позже.")
            }
            override fun onReceivedError(view: WebView?, request: WebResourceRequest, error: WebResourceError?) {
                if (request.isForMainFrame) showError("Сервер пока недоступен. Проверьте интернет и повторите подключение.")
            }
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            showError("Обновите Android System WebView или Chrome в магазине приложений, чтобы открыть Сигнал.")
            return
        }
        WebViewCompat.addWebMessageListener(webView, "signalAndroidBridge", setOf(SignalApi.SERVER_ORIGIN)) { _, message, sourceOrigin, isMainFrame, proxy ->
            if (destroyed || !isMainFrame || !trusted(sourceOrigin)) return@addWebMessageListener
            val text = runCatching { message.data }.getOrNull() ?: return@addWebMessageListener
            if (text.length > 1024) return@addWebMessageListener
            val data = runCatching { JSONObject(text) }.getOrNull() ?: return@addWebMessageListener
            reply = proxy
            when (data.optString("type")) {
                "openCall" -> {
                    val id = data.optString("channelId")
                    val name = data.optString("channelName").take(40).filter { !it.isISOControl() }
                    if (!SignalApi.validChannelId(id)) return@addWebMessageListener
                    startActivity(Intent(this, CallActivity::class.java).putExtra("channelId", id).putExtra("channelName", name.ifBlank { "Канал" }))
                    sendCallState()
                }
                "leaveCall" -> {
                    // A normal start command reaches the existing foreground
                    // call; it never starts a new capture service from WebView.
                    if (CallService.activeState.value.channelId != null) startService(Intent(this, CallService::class.java).setAction(CallService.ACTION_LEAVE))
                    sendCallState()
                }
                "getCallState" -> sendCallState()
                "checkUpdate" -> updater.check()
            }
        }
        scope.launch { CallService.activeState.collect { sendCallState() } }
        val restored = savedInstanceState != null && webView.restoreState(savedInstanceState) != null
        val deepLink = inviteUrl(intent?.data)
        if (deepLink != null) webView.loadUrl(deepLink)
        else if (!restored || !trusted(Uri.parse(webView.url.orEmpty()))) webView.loadUrl(SignalApi.SERVER_ORIGIN + "/")
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) { override fun handleOnBackPressed() { goBack() } })
    }

    private fun trusted(uri: Uri): Boolean = uri.scheme == "https" && uri.host == "13.143.172.92" && uri.port == 9443 && uri.userInfo == null

    private fun inviteUrl(uri: Uri?): String? {
        if (uri == null) return null
        val code = if (uri.scheme == "signal" && uri.host == "invite") uri.path?.removePrefix("/") else if (trusted(uri)) uri.getQueryParameter("invite") else null
        return code?.takeIf { invitation.matches(it) }?.let { SignalApi.SERVER_ORIGIN + "/?invite=" + Uri.encode(it) }
    }

    private fun external(uri: Uri) {
        inviteUrl(uri)?.let { webView.loadUrl(it); return }
        if (uri.scheme != "https" && uri.scheme != "http") return
        try { startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)) }
        catch (_: Exception) { Toast.makeText(this, "Не удалось открыть браузер.", Toast.LENGTH_SHORT).show() }
    }

    private fun sendCallState() {
        if (destroyed) return
        val current = CallService.activeState.value
        val state = when (current.phase) {
            "connecting", "connected", "reconnecting", "error" -> current.phase
            "ended" -> "disconnected"
            else -> "idle"
        }
        val data = JSONObject().put("type", "callState").put("state", state)
        current.channelId?.let { data.put("channelId", it) }
        if (state == "error") data.put("error", "Не удалось подключиться к звонку. Откройте комнату и повторите попытку.")
        runCatching { reply?.postMessage(data.toString()) }
    }

    private fun showError(message: String) { errorText.text = message; errorPanel.visibility = View.VISIBLE; progress.visibility = View.GONE }
    private fun goBack() { if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true) }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); inviteUrl(intent.data)?.let { errorPanel.visibility = View.GONE; webView.loadUrl(it) } }
    override fun onResume() { super.onResume(); if (::updater.isInitialized) updater.onResume(); sendCallState() }
    override fun onPause() { CookieManager.getInstance().flush(); super.onPause() }
    override fun onSaveInstanceState(outState: Bundle) { webView.saveState(outState); super.onSaveInstanceState(outState) }
    override fun onDestroy() {
        destroyed = true
        reply = null
        if (::updater.isInitialized) updater.close()
        scope.cancel()
        if (::webView.isInitialized) { (webView.parent as? ViewGroup)?.removeView(webView); webView.destroy() }
        super.onDestroy()
    }
}
