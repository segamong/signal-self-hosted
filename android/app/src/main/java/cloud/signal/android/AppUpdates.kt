package cloud.signal.android

import android.app.AlertDialog
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlin.coroutines.coroutineContext

private data class AndroidRelease(val version: String, val versionCode: Long, val filename: String, val sha256: String, val size: Long)

class AppUpdates(private val activity: ComponentActivity, private val scope: CoroutineScope) {
    private var operation: Job? = null
    private var dialog: AlertDialog? = null
    private var pendingInstall: File? = null
    private var pendingRelease: AndroidRelease? = null
    private var waitingForPermission = false
    private var closed = false

    fun check() {
        if (closed || activity.isFinishing || operation?.isCompleted == false) return
        progressDialog("Проверяем обновление…")
        operation = scope.launch {
            try {
                val release = withContext(Dispatchers.IO) { readLatest() }
                dismissDialog()
                if (release.versionCode <= BuildConfig.VERSION_CODE) {
                    showMessage("Сигнал обновлён", "Установлена последняя версия ${BuildConfig.VERSION_NAME}.")
                } else {
                    dialog = AlertDialog.Builder(activity)
                        .setTitle("Доступен Сигнал ${release.version}")
                        .setMessage("Загрузить обновление (${(release.size / 1_000_000.0).toInt()} МБ)? Аккаунт и настройки сохранятся. Android попросит подтвердить установку.")
                        .setPositiveButton("Загрузить") { _, _ -> download(release) }
                        .setNegativeButton("Позже", null)
                        .show()
                }
            } catch (_: CancellationException) {
                dismissDialog()
            } catch (_: Exception) {
                dismissDialog()
                showMessage("Обновление пока недоступно", "Не удалось проверить новую версию. Проверьте интернет и повторите позже.")
            }
        }
    }

    private fun download(release: AndroidRelease) {
        if (closed || activity.isFinishing || operation?.isCompleted == false) return
        val label = progressDialog("Загружаем Сигнал ${release.version}…")
        operation = scope.launch {
            try {
                val apk = withContext(Dispatchers.IO) {
                    downloadAndVerify(release) { percent ->
                        activity.runOnUiThread { if (!closed) label.text = "Загружаем Сигнал ${release.version}… $percent%" }
                    }
                }
                dismissDialog()
                pendingInstall = apk
                pendingRelease = release
                requestInstall(apk)
            } catch (_: CancellationException) {
                dismissDialog()
            } catch (_: Exception) {
                dismissDialog()
                showMessage("Обновление не установлено", "Не удалось загрузить или проверить файл обновления. Повторите позже. Установленная версия продолжит работать.")
            }
        }
    }

    private fun readLatest(): AndroidRelease {
        val connection = connection("latest.json")
        try {
            if (connection.responseCode != 200) throw IOException("Update metadata unavailable")
            val bytes = connection.inputStream.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(4096)
                while (true) {
                    val size = input.read(buffer)
                    if (size < 0) break
                    if (output.size() + size > 16_384) throw IOException("Update metadata too large")
                    output.write(buffer, 0, size)
                }
                output.toByteArray()
            }
            return parseRelease(JSONObject(bytes.toString(Charsets.UTF_8)))
        } finally { connection.disconnect() }
    }

    private fun parseRelease(json: JSONObject): AndroidRelease {
        val version = json.optString("version")
        val code = json.optLong("versionCode", -1)
        val file = json.optString("file")
        val hash = json.optString("sha256").lowercase()
        val size = json.optLong("size", -1)
        if (!Regex("[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?").matches(version) || code !in 1..2_100_000_000L || !Regex("Signal-Android-[A-Za-z0-9._-]+\\.apk").matches(file) || !Regex("[a-f0-9]{64}").matches(hash) || size !in 1..200_000_000L) throw IOException("Invalid update metadata")
        return AndroidRelease(version, code, file, hash, size)
    }

    fun saveState(state: Bundle) {
        val release = pendingRelease ?: return
        if (!waitingForPermission) return
        state.putString("signal.update.pending", JSONObject().put("version", release.version).put("versionCode", release.versionCode).put("file", release.filename).put("sha256", release.sha256).put("size", release.size).toString())
    }

    fun restoreState(state: Bundle?) {
        val text = state?.getString("signal.update.pending") ?: return
        val release = runCatching { parseRelease(JSONObject(text)) }.getOrNull() ?: return
        val apk = File(File(activity.cacheDir, "updates"), release.filename)
        if (apk.isFile && apk.length() == release.size && release.versionCode > BuildConfig.VERSION_CODE) {
            pendingRelease = release
            pendingInstall = apk
            waitingForPermission = true
        }
    }

    private suspend fun downloadAndVerify(release: AndroidRelease, onProgress: (Int) -> Unit): File {
        val folder = File(activity.cacheDir, "updates").apply { if (!exists() && !mkdirs()) throw IOException("No update directory") }
        val partial = File(folder, "${release.filename}.part")
        val apk = File(folder, release.filename)
        val connection = connection(release.filename)
        var completed = false
        try {
            if (connection.responseCode != 200) throw IOException("APK unavailable")
            // getContentLengthLong is unavailable on Android 6. The metadata
            // size and streamed byte count are still checked on every version.
            val announced = connection.getHeaderField("Content-Length")?.toLongOrNull() ?: -1L
            if (announced >= 0 && announced != release.size) throw IOException("Unexpected APK size")
            val digest = MessageDigest.getInstance("SHA-256")
            connection.inputStream.use { input ->
                partial.outputStream().use { output ->
                    val buffer = ByteArray(65536)
                    var total = 0L
                    var lastPercent = -1
                    while (true) {
                        coroutineContext.ensureActive()
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        if (total > release.size) throw IOException("APK too large")
                        digest.update(buffer, 0, count)
                        output.write(buffer, 0, count)
                        val percent = (total * 100 / release.size).toInt()
                        if (percent != lastPercent) { onProgress(percent); lastPercent = percent }
                    }
                    if (total != release.size) throw IOException("Incomplete APK")
                }
            }
            val hash = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
            if (hash != release.sha256) throw IOException("APK integrity mismatch")
            verifySigning(partial, release)
            coroutineContext.ensureActive()
            if (apk.exists() && !apk.delete()) throw IOException("Cannot replace update cache")
            if (!partial.renameTo(apk)) throw IOException("Cannot save update")
            completed = true
            return apk
        } finally {
            connection.disconnect()
            if (!completed) partial.delete()
        }
    }

    @Suppress("DEPRECATION")
    private fun verifySigning(apk: File, release: AndroidRelease) {
        val manager = activity.packageManager
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val archive = manager.getPackageArchiveInfo(apk.absolutePath, flags) ?: throw IOException("APK cannot be read")
        val installed = manager.getPackageInfo(activity.packageName, flags)
        val archiveCode = PackageInfoCompat.getLongVersionCode(archive)
        if (archive.packageName != activity.packageName || archiveCode != release.versionCode || archive.versionName != release.version || archiveCode <= PackageInfoCompat.getLongVersionCode(installed)) throw IOException("Unexpected application version")
        val current = signingCertificates(installed)
        val next = signingCertificates(archive)
        if (current.isEmpty() || next != current) throw IOException("APK signing identity mismatch")
    }

    @Suppress("DEPRECATION")
    private fun signingCertificates(info: PackageInfo): Set<List<Byte>> {
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.signingInfo?.apkContentsSigners else info.signatures
        // Older Android verifies the APK's v1 signature. Compare its full
        // certificate set with the installed app rather than trusting a hash.
        return signatures?.map { it.toByteArray().toList() }?.toSet().orEmpty()
    }

    private fun connection(file: String): HttpURLConnection = ServerTls.connection(URL("${SignalApi.SERVER_ORIGIN}/downloads/android/$file")).apply {
        instanceFollowRedirects = false
        connectTimeout = 15_000
        readTimeout = 30_000
        useCaches = false
        setRequestProperty("Cache-Control", "no-cache")
        setRequestProperty("Accept", if (file == "latest.json") "application/json" else "application/vnd.android.package-archive")
        setRequestProperty("User-Agent", "SignalAndroid/${BuildConfig.VERSION_NAME}")
    }

    private fun requestInstall(apk: File) {
        if (closed || activity.isFinishing || !apk.isFile) return
        if (canInstallPackages()) {
            openInstaller(apk)
        } else {
            dialog = AlertDialog.Builder(activity).setTitle("Разрешение на обновление")
                .setMessage(if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    "Разрешите Сигналу устанавливать обновления из вашего сервера в настройках Android. Каждая установка потребует вашего подтверждения."
                    else "В настройках безопасности Android разрешите установку приложений из неизвестных источников. Файл уже проверен: его подписал тот же разработчик, что и установленный Сигнал. После обновления можно снова отключить это разрешение.")
                .setPositiveButton("Открыть настройки") { _, _ ->
                    try {
                        waitingForPermission = true
                        val settings = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
                            else Intent(Settings.ACTION_SECURITY_SETTINGS)
                        activity.startActivity(settings)
                    } catch (_: Exception) { waitingForPermission = false; showMessage("Настройки недоступны", "Откройте настройки Android и разрешите установку обновлений для Сигнала.") }
                }.setNegativeButton("Отмена", null).show()
        }
    }

    @Suppress("DEPRECATION")
    private fun canInstallPackages(): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        activity.packageManager.canRequestPackageInstalls()
    } else {
        Settings.Secure.getInt(activity.contentResolver, Settings.Secure.INSTALL_NON_MARKET_APPS, 0) == 1
    }

    fun onResume() {
        if (closed || !waitingForPermission) return
        waitingForPermission = false
        val apk = pendingInstall ?: return
        val release = pendingRelease ?: return
        if (!canInstallPackages()) {
            Toast.makeText(activity, "Разрешение на установку не предоставлено.", Toast.LENGTH_LONG).show()
            return
        }
        operation = scope.launch {
            try {
                // Android may recreate the Activity while its settings are open.
                // Verify the saved file again before granting it to the installer.
                withContext(Dispatchers.IO) {
                    if (!apk.isFile || apk.length() != release.size) throw IOException("Cached update changed")
                    val digest = MessageDigest.getInstance("SHA-256")
                    apk.inputStream().use { input ->
                        val buffer = ByteArray(65536)
                        while (true) {
                            coroutineContext.ensureActive()
                            val count = input.read(buffer)
                            if (count < 0) break
                            digest.update(buffer, 0, count)
                        }
                    }
                    if (digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) } != release.sha256) throw IOException("Cached update integrity mismatch")
                    verifySigning(apk, release)
                }
                openInstaller(apk)
            } catch (_: CancellationException) {
                // The next manual check can resume after Activity recreation.
            } catch (_: Exception) {
                showMessage("Обновление не установлено", "Файл обновления больше недоступен или не прошёл проверку. Проверьте обновления ещё раз.")
            }
        }
    }

    private fun openInstaller(apk: File) {
        try {
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", apk)
            val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .apply { clipData = ClipData.newRawUri("Обновление Сигнала", uri) }
            activity.startActivity(intent)
        } catch (_: Exception) { showMessage("Установка недоступна", "Не удалось открыть установщик Android. Повторите обновление позже.") }
    }

    private fun progressDialog(text: String): TextView {
        dismissDialog()
        val label = TextView(activity).apply { this.text = text; setPadding(25, 10, 25, 10) }
        val layout = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(25, 25, 25, 25)
            addView(ProgressBar(activity))
            addView(label)
        }
        dialog = AlertDialog.Builder(activity).setTitle("Обновление Сигнала").setView(layout).setNegativeButton("Отмена") { _, _ -> operation?.cancel() }.setCancelable(false).show()
        return label
    }

    private fun showMessage(title: String, message: String) {
        if (closed || activity.isFinishing) return
        dismissDialog()
        dialog = AlertDialog.Builder(activity).setTitle(title).setMessage(message).setPositiveButton("Хорошо", null).show()
    }
    private fun dismissDialog() { dialog?.dismiss(); dialog = null }
    fun close() { closed = true; operation?.cancel(); dismissDialog() }
}
