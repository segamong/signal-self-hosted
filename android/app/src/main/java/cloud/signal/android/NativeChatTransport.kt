package cloud.signal.android

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject

/** Keeps legacy WebViews off the network without weakening TLS verification. */
class NativeChatTransport(private val scope: CoroutineScope, private val send: (JSONObject) -> Unit) {
    private val requests = mutableMapOf<String, Job>()
    private val requestIdentifier = Regex("[A-Za-z0-9_.:-]{1,100}")
    private var generation = 0L
    private var socketGeneration = 0L
    private var socket: WebSocket? = null
    private var retry: Job? = null
    private var subscribed = false
    private var attempts = 0
    private var closed = false

    fun onMessage(data: JSONObject): Boolean {
        if (closed) return false
        when (data.optString("type")) {
            "requestApi" -> request(data)
            "subscribeEvents" -> {
                if (!subscribed) {
                    subscribed = true
                    attempts = 0
                    connect()
                }
            }
            "unsubscribeEvents" -> unsubscribe()
            else -> return false
        }
        return true
    }

    private fun request(data: JSONObject) {
        val id = data.optString("requestId")
        if (!requestIdentifier.matches(id) || requests.containsKey(id)) return
        val path = data.optString("path")
        val body = data.optJSONObject("body")
        if (!SignalApi.validApiPath(path) || (data.has("body") && body == null)) {
            respond(id, 400, JSONObject().put("error", "Некорректный запрос."))
            return
        }
        if (requests.size >= 8) {
            respond(id, 429, JSONObject().put("error", "Дождитесь завершения предыдущих запросов."))
            return
        }
        val currentGeneration = generation
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                val result = SignalApi.requestApi(path, body)
                if (!closed && generation == currentGeneration) {
                    respond(id, result.status, result.data)
                    if (result.status == 401 && path != "/api/login" && path != "/api/register") sessionExpired()
                }
            } catch (_: CancellationException) {
                // Navigation discards the old document's requests and replies.
            } catch (_: Exception) {
                if (!closed && generation == currentGeneration) respond(id, 503, JSONObject().put("error", "Не удалось связаться с сервером. Проверьте подключение."))
            } finally {
                if (generation == currentGeneration) requests.remove(id)
            }
        }
        requests[id] = job
        job.start()
    }

    private fun respond(id: String, status: Int, data: JSONObject) {
        if (!closed) send(JSONObject().put("type", "apiResponse").put("requestId", id).put("status", status).put("data", data))
    }

    private fun event(value: JSONObject) {
        if (!closed) send(JSONObject().put("type", "serverEvent").put("event", value))
    }

    private fun connection(connected: Boolean) = event(JSONObject().put("type", "connection").put("connected", connected))

    private fun connect() {
        if (closed || !subscribed) return
        val currentGeneration = generation
        val currentSocket = ++socketGeneration
        retry = scope.launch {
            val cookie = SignalApi.sessionCookie()
            if (closed || !subscribed || generation != currentGeneration || socketGeneration != currentSocket) return@launch
            if (cookie == null) { sessionExpired(); return@launch }
            val request = Request.Builder().url("wss://13.143.172.92:9443/api/ws")
                .header("Origin", SignalApi.SERVER_ORIGIN)
                .header("Cookie", cookie)
                .header("User-Agent", "SignalAndroid/${BuildConfig.VERSION_NAME}")
                .build()
            val listener = object : WebSocketListener() {
                private fun dispatch(action: () -> Unit) {
                    scope.launch {
                        if (!closed && subscribed && generation == currentGeneration && socketGeneration == currentSocket) action()
                    }
                }
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    dispatch {
                        attempts = 0
                        connection(true)
                    }
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (text.length > 2_000_000) { webSocket.close(1009, "Event too large"); return }
                    val value = runCatching { JSONObject(text) }.getOrNull() ?: return
                    // Preserve the server event, but never accept bridge control
                    // messages from a WebSocket payload.
                    dispatch { event(value) }
                }
                override fun onMessage(webSocket: WebSocket, bytes: ByteString) { webSocket.close(1003, "Text events required") }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    dispatch {
                        socket = null
                        connection(false)
                        if (code == 4001) sessionExpired() else scheduleReconnect()
                    }
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    dispatch {
                        socket = null
                        connection(false)
                        if (response?.code == 401) sessionExpired() else scheduleReconnect()
                    }
                }
            }
            try {
                socket = ServerTls.httpClient.newWebSocket(request, listener)
            } catch (_: Exception) {
                connection(false)
                scheduleReconnect()
            }
        }
    }

    private fun scheduleReconnect() {
        if (closed || !subscribed) return
        val wait = minOf(15_000L, 1_000L shl minOf(attempts++, 4))
        retry = scope.launch {
            delay(wait)
            connect()
        }
    }

    private fun sessionExpired() {
        unsubscribe()
        event(JSONObject().put("type", "session-expired"))
    }

    private fun unsubscribe() {
        subscribed = false
        socketGeneration++
        retry?.cancel()
        retry = null
        socket?.cancel()
        socket = null
    }

    fun reset() {
        generation++
        unsubscribe()
        requests.values.forEach { it.cancel() }
        requests.clear()
    }

    fun close() {
        reset()
        closed = true
    }
}
