package cloud.signal.android

import android.app.Application

class SignalApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        ServerTls.initialize(this)
    }
}
