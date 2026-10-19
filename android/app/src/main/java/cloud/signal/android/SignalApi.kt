package cloud.signal.android

import android.net.Uri
import android.webkit.CookieManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

data class JoinCredentials(val url: String, val token: String)
data class SignalUser(val id: String, val username: String)
class SignalApiException(val status: Int, message: String) : IOException(message)

object SignalApi {
    const val SERVER_ORIGIN = "https://13.143.172.92:9443"
    private val identifier = Regex("[A-Za-z0-9_-]{1,100}")
    private val username = Regex("[A-Za-z0-9_-]{3,32}")

    fun validChannelId(value: String): Boolean = identifier.matches(value)

    suspend fun joinChannel(channelId: String): JoinCredentials {
        require(validChannelId(channelId)) { "Некорректный канал." }
        val response = request("/api/channels/${Uri.encode(channelId)}/join", JSONObject())
        val endpoint = response.optString("url")
        val uri = Uri.parse(endpoint)
        val token = response.optString("token")
        if (uri.scheme != "wss" || uri.host != "13.143.172.92" || uri.port != 9443 || uri.userInfo != null || uri.query != null || uri.fragment != null || (uri.path ?: "").let { it.isNotEmpty() && it != "/" } || token.length !in 20..20_000) {
            throw IOException("Сервер вернул неподходящие параметры звонка.")
        }
        return JoinCredentials(endpoint, token)
    }

    suspend fun channelMembers(channelId: String): Map<String, String> {
        require(validChannelId(channelId)) { "Некорректный канал." }
        val members = request("/api/channels/${Uri.encode(channelId)}/members").optJSONArray("members") ?: return emptyMap()
        return buildMap {
            for (index in 0 until members.length()) {
                val member = members.optJSONObject(index) ?: continue
                val id = member.optString("id")
                val name = member.optString("username")
                if (identifier.matches(id) && username.matches(name)) put(id, name)
            }
        }
    }

    suspend fun currentUser(): SignalUser? {
        val user = request("/api/me").optJSONObject("user") ?: return null
        val id = user.optString("id")
        val name = user.optString("username")
        if (!identifier.matches(id) || !username.matches(name)) throw IOException("Не удалось прочитать аккаунт.")
        return SignalUser(id, name)
    }

    private suspend fun request(path: String, body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val connection = URL(SERVER_ORIGIN + path).openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15_000
            connection.readTimeout = 20_000
            connection.useCaches = false
            connection.requestMethod = if (body == null) "GET" else "POST"
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Origin", SERVER_ORIGIN)
            connection.setRequestProperty("User-Agent", "SignalAndroid/${BuildConfig.VERSION_NAME}")
            CookieManager.getInstance().getCookie(SERVER_ORIGIN)?.takeIf { it.isNotBlank() }?.let { connection.setRequestProperty("Cookie", it) }
            if (body != null) {
                val bytes = body.toString().toByteArray(Charsets.UTF_8)
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.use { input ->
                val result = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    if (result.size() + read > 2_000_000) throw IOException("Ответ сервера слишком большой.")
                    result.write(buffer, 0, read)
                }
                result.toString(Charsets.UTF_8.name())
            }.orEmpty()
            val data = runCatching { JSONObject(text) }.getOrNull()
            if (status !in 200..299) {
                val message = data?.optString("error")?.takeIf { it.isNotBlank() && it.length <= 300 && !it.contains(Regex("https?://|wss?://|access_token|Bearer|eyJ", RegexOption.IGNORE_CASE)) }
                    ?: if (status == 401) "Войдите в аккаунт ещё раз." else "Не удалось выполнить запрос к серверу."
                throw SignalApiException(status, message)
            }
            data ?: throw IOException("Сервер вернул неожиданный ответ.")
        } catch (error: SignalApiException) {
            throw error
        } catch (error: IOException) {
            throw IOException("Не удалось связаться с сервером. Проверьте подключение.")
        } finally {
            connection.disconnect()
        }
    }
}
