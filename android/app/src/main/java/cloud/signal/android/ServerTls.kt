package cloud.signal.android

import android.content.Context
import android.os.Build
import okhttp3.OkHttpClient
import java.io.IOException
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/** HTTPS and WSS policy for this installation, without changing global TLS defaults. */
object ServerTls {
    private const val SERVER_HOST = "13.143.172.92"
    private const val SERVER_PORT = 9443
    @Volatile private var configured: Configuration? = null

    private data class Configuration(val client: OkHttpClient, val legacySockets: SSLSocketFactory?)

    @Synchronized
    fun initialize(context: Context) {
        if (configured != null) return
        val builder = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .addInterceptor { chain ->
                val url = chain.request().url
                // OkHttp normalizes WSS handshake URLs to HTTPS before interceptors.
                if (url.scheme != "https" || url.host != SERVER_HOST || url.port != SERVER_PORT ||
                    url.username.isNotEmpty() || url.password.isNotEmpty()) {
                    throw IOException("Неподходящий адрес сервера.")
                }
                chain.proceed(chain.request())
            }
        var legacySockets: SSLSocketFactory? = null
        if (Build.VERSION.SDK_INT < 24) {
            // Android 5–6 do not read network_security_config. Supply the same
            // two public CA roots here, with normal PKIX and hostname checks.
            val systemTrust = trustManager(null)
            val roots = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null) }
            addRoot(context, roots, R.raw.isrg_root_x1, "isrg-x1", "96bcec06264976f37460779acf28c5a7cfe8a3c0aae11a8ffcee05c0bddf08c6")
            addRoot(context, roots, R.raw.isrg_root_x2, "isrg-x2", "69729b8e15a86efc177a57afb7171dfc64add28c2fca8cf1507e34453ccb1470")
            val extraTrust = trustManager(roots)
            val combinedTrust = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
                    systemTrust.checkClientTrusted(chain, authType)

                override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                    try {
                        systemTrust.checkServerTrusted(chain, authType)
                    } catch (systemFailure: CertificateException) {
                        try {
                            extraTrust.checkServerTrusted(chain, authType)
                        } catch (extraFailure: CertificateException) {
                            extraFailure.addSuppressed(systemFailure)
                            throw extraFailure
                        }
                    }
                }

                override fun getAcceptedIssuers(): Array<X509Certificate> =
                    systemTrust.acceptedIssuers + extraTrust.acceptedIssuers
            }
            legacySockets = SSLContext.getInstance("TLS").apply {
                init(null, arrayOf(combinedTrust), null)
            }.socketFactory
            builder.sslSocketFactory(legacySockets, combinedTrust)
        }
        // Android 7+ uses the equivalent server-scoped XML trust anchors.
        // Both clients retain their default hostname verifier.
        configured = Configuration(builder.build(), legacySockets)
    }

    val httpClient: OkHttpClient
        get() = configuration().client

    fun connection(url: URL): HttpsURLConnection {
        if (url.protocol != "https" || url.host != SERVER_HOST || url.port != SERVER_PORT || url.userInfo != null) {
            throw IOException("Неподходящий адрес сервера.")
        }
        val configuration = configuration()
        return (url.openConnection() as HttpsURLConnection).apply {
            instanceFollowRedirects = false
            configuration.legacySockets?.let { sslSocketFactory = it }
        }
    }

    private fun configuration(): Configuration =
        checkNotNull(configured) { "Call ServerTls.initialize before network requests." }

    private fun trustManager(store: KeyStore?): X509TrustManager =
        TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
            init(store)
        }.trustManagers.filterIsInstance<X509TrustManager>().single()

    private fun addRoot(context: Context, store: KeyStore, resource: Int, alias: String, fingerprint: String) {
        val root = context.resources.openRawResource(resource).use {
            CertificateFactory.getInstance("X.509").generateCertificate(it) as X509Certificate
        }
        val actual = MessageDigest.getInstance("SHA-256").digest(root.encoded)
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        check(actual == fingerprint && root.basicConstraints >= 0 && root.subjectX500Principal == root.issuerX500Principal) {
            "Unexpected bundled certificate authority."
        }
        root.verify(root.publicKey)
        store.setCertificateEntry(alias, root)
    }
}
