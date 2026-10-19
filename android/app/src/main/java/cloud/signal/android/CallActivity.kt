package cloud.signal.android

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import io.livekit.android.room.Room
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** The WebView never captures media; this Activity owns native permission gestures. */
class CallActivity : ComponentActivity() {
    private val uiScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var collectJob: Job? = null
    private var service: CallService? = null
    private var bound = false
    private var channelId = ""
    private var channelName = ""
    private var switchPrompt: String? = null
    private var currentState = CallState()
    private var pendingPermission: String? = null
    private var screenRequest: ScreenRequest? = null
    private var notificationRequested = false
    private var renderedRoom: Room? = null
    private val tiles = linkedMapOf<String, VideoTile>()
    private var participantOrder = emptyList<String>()
    private var screenTile: VideoTile? = null
    private var screenTileIdentity: String? = null
    private var screenChoiceIds = emptyList<String>()
    private var fullscreen: Dialog? = null
    private var fullscreenTrack: io.livekit.android.room.track.VideoTrack? = null

    private lateinit var root: LinearLayout
    private lateinit var title: TextView
    private lateinit var status: TextView
    private lateinit var error: TextView
    private lateinit var participantGrid: GridLayout
    private lateinit var screenContainer: LinearLayout
    private lateinit var screenChoices: LinearLayout
    private lateinit var options: LinearLayout
    private lateinit var microphone: Button
    private lateinit var camera: Button
    private lateinit var screen: Button
    private lateinit var deafen: Button
    private lateinit var speaker: Button
    private lateinit var flip: Button
    private lateinit var retry: Button
    private lateinit var appAudio: CheckBox
    private lateinit var fps: Spinner
    private lateinit var bitrate: Spinner
    private lateinit var codec: Spinner

    private data class ScreenRequest(val audio: Boolean, val fps: Int, val bitrate: Int, val codec: String)

    private val mediaPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val action = pendingPermission
        pendingPermission = null
        if (!granted) {
            notice("Разрешение не выдано. Его можно изменить в настройках приложения.")
            return@registerForActivityResult
        }
        when (action) {
            "microphone" -> service?.setMicrophone(true)
            "camera" -> service?.setCamera(true)
            "headphones" -> service?.setSpeaker(false)
        }
    }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) notice("Звонок продолжится. Уведомление можно разрешить в настройках приложения.")
    }
    private val screenConsent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val desired = screenRequest
        screenRequest = null
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null || desired == null) return@registerForActivityResult
        val current = service
        if (current == null || currentState.phase != "connected") {
            notice("Сначала подключитесь к звонку, затем повторно выберите экран.")
            return@registerForActivityResult
        }
        current.startScreen(data, desired.audio, desired.fps, desired.bitrate, desired.codec)
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            service = (binder as? CallService.LocalBinder)?.service
            collectJob?.cancel()
            collectJob = uiScope.launch { CallService.activeState.collect { render(it) } }
        }
        override fun onServiceDisconnected(name: ComponentName?) {
            service = null
            disposeVideos()
            status.text = "Звонок завершён"
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        channelId = intent.getStringExtra(CallService.EXTRA_CHANNEL_ID) ?: CallService.activeState.value.channelId.orEmpty()
        channelName = intent.getStringExtra(CallService.EXTRA_CHANNEL_NAME).orEmpty().take(100)
        if (!CHANNEL_ID.matches(channelId)) { finish(); return }
        pendingPermission = savedInstanceState?.getString("pendingPermission")
        notificationRequested = savedInstanceState?.getBoolean("notificationRequested") == true
        if (savedInstanceState?.getBoolean("screenPending") == true) {
            screenRequest = ScreenRequest(savedInstanceState.getBoolean("screenAudio"), savedInstanceState.getInt("screenFps", 30), savedInstanceState.getInt("screenBitrate", 24_000_000), savedInstanceState.getString("screenCodec") ?: "h264")
        }
        buildUi()
    }

    override fun onStart() {
        super.onStart()
        if (!::root.isInitialized) return
        val connect = Intent(this, CallService::class.java)
            .putExtra(CallService.EXTRA_CHANNEL_ID, channelId)
            .putExtra(CallService.EXTRA_CHANNEL_NAME, channelName)
        try {
            startForegroundService(connect)
            bound = bindService(Intent(this, CallService::class.java), connection, Context.BIND_AUTO_CREATE)
            if (Build.VERSION.SDK_INT >= 33 && !notificationRequested && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                notificationRequested = true
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        } catch (_: Exception) {
            error.text = "Не удалось запустить звонок. Откройте приложение и повторите."
            error.visibility = View.VISIBLE
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val requested = intent.getStringExtra(CallService.EXTRA_CHANNEL_ID).orEmpty()
        if (CHANNEL_ID.matches(requested)) {
            channelId = requested
            channelName = intent.getStringExtra(CallService.EXTRA_CHANNEL_NAME).orEmpty().take(100)
            render(CallService.activeState.value)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("pendingPermission", pendingPermission)
        outState.putBoolean("notificationRequested", notificationRequested)
        screenRequest?.let {
            outState.putBoolean("screenPending", true)
            outState.putBoolean("screenAudio", it.audio)
            outState.putInt("screenFps", it.fps)
            outState.putInt("screenBitrate", it.bitrate)
            outState.putString("screenCodec", it.codec)
        }
        super.onSaveInstanceState(outState)
    }

    override fun onStop() {
        collectJob?.cancel()
        collectJob = null
        disposeVideos()
        if (bound) { unbindService(connection); bound = false }
        service = null
        super.onStop()
    }

    override fun onDestroy() {
        disposeVideos()
        uiScope.cancel()
        super.onDestroy()
    }

    private fun buildUi() {
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BACKGROUND)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setOnApplyWindowInsetsListener { view, insets ->
                val system = insets.getInsets(WindowInsets.Type.systemBars())
                view.setPadding(system.left + dp(12), system.top + dp(10), system.right + dp(12), system.bottom + dp(10))
                insets
            }
        }
        title = text(channelName.ifBlank { "Голосовой канал" }, 21f, TEXT)
        status = text("Подключаемся…", 13f, MUTED)
        root.addView(title)
        root.addView(status)
        error = text("", 13f, Color.rgb(239, 184, 129)).apply {
            visibility = View.GONE
            setPadding(0, dp(8), 0, dp(8))
            setOnClickListener { service?.clearError() }
        }
        root.addView(error)
        val scroll = ScrollView(this).apply { isFillViewport = true }
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(12), 0, dp(12)) }
        screenContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        screenChoices = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        body.addView(screenContainer)
        body.addView(screenChoices)
        participantGrid = GridLayout(this).apply { columnCount = 2 }
        body.addView(participantGrid, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        val quality = button("Качество показа экрана") { options.visibility = if (options.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
        body.addView(quality)
        options = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE; setPadding(0, dp(8), 0, dp(8)) }
        options.addView(text("Исходное разрешение. Частота и битрейт — цели: фактические значения зависят от телефона, сети и сервера.", 12f, MUTED))
        fps = spinner(listOf("Исходное / 30 кадров/с", "Исходное / 60 кадров/с"))
        bitrate = spinner(listOf("12 Мбит/с", "24 Мбит/с · высокое качество", "40 Мбит/с · максимум")).apply { setSelection(1) }
        codec = spinner(listOf("H.264", "VP9", "VP8"))
        options.addView(fps)
        options.addView(bitrate)
        options.addView(codec)
        appAudio = CheckBox(this).apply {
            text = "Звук приложений вместе с микрофоном"
            setTextColor(TEXT)
            textSize = 13f
            buttonTintList = ColorStateList.valueOf(ACCENT)
            isChecked = false
        }
        options.addView(appAudio)
        options.addView(text("Включается отдельно, когда микрофон уже включён. Android разрешает захват звука лишь некоторых приложений: игры и медиа без запрета записи; защищённый контент и звонки могут быть без звука. Выключение микрофона отключает и этот звук. Для смены настроек остановите показ.", 12f, MUTED))
        body.addView(options)
        scroll.addView(body)
        root.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        val controls = GridLayout(this).apply { columnCount = 3 }
        microphone = button("Микрофон выкл.") {
            if (currentState.microphone) service?.setMicrophone(false) else permission("microphone", Manifest.permission.RECORD_AUDIO) { service?.setMicrophone(true) }
        }
        camera = button("Камера выкл.") {
            if (currentState.camera) service?.setCamera(false) else permission("camera", Manifest.permission.CAMERA) { service?.setCamera(true) }
        }
        screen = button("Показать экран") {
            if (currentState.screen) service?.stopScreen() else requestScreen()
        }
        speaker = button("Динамик") {
            if (currentState.speaker) permission("headphones", Manifest.permission.BLUETOOTH_CONNECT) { service?.setSpeaker(false) }
            else service?.setSpeaker(true)
        }
        deafen = button("Звук включён") { service?.setDeafened(!currentState.deafened) }
        flip = button("Сменить камеру") { service?.flipCamera() }
        listOf(microphone, camera, screen, speaker, deafen, flip).forEachIndexed { index, view -> addControl(controls, view, index) }
        root.addView(controls)
        val bottom = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        bottom.addView(button("К чатам") { finish() }, LinearLayout.LayoutParams(0, dp(52), 1f))
        retry = button("Подключиться") {
            service?.connect(channelId, channelName)
            // A stopped-but-bound service must be started again for the next call.
            startForegroundService(Intent(this, CallService::class.java).putExtra(CallService.EXTRA_CHANNEL_ID, channelId).putExtra(CallService.EXTRA_CHANNEL_NAME, channelName))
        }.apply { visibility = View.GONE }
        bottom.addView(retry, LinearLayout.LayoutParams(0, dp(52), 1f))
        bottom.addView(button("Завершить") { service?.leave(); finish() }.apply { setTextColor(Color.rgb(250, 178, 178)) }, LinearLayout.LayoutParams(0, dp(52), 1f))
        root.addView(bottom)
        setContentView(root)
        root.requestApplyInsets()
    }

    private fun render(state: CallState) {
        currentState = state
        if (state.channelId != null && state.channelId != channelId && state.phase in setOf("connecting", "connected", "reconnecting")) {
            if (switchPrompt != channelId) {
                switchPrompt = channelId
                AlertDialog.Builder(this)
                    .setTitle("Перейти в другой канал?")
                    .setMessage("Текущий звонок в «${state.channelName}» завершится.")
                    .setPositiveButton("Перейти") { _, _ -> service?.connect(channelId, channelName, replace = true); switchPrompt = null }
                    .setNegativeButton("Остаться") { _, _ -> channelId = state.channelId; channelName = state.channelName; switchPrompt = null; render(state) }
                    .setOnCancelListener { channelId = state.channelId; channelName = state.channelName; switchPrompt = null; render(state) }
                    .show()
            }
        }
        title.text = state.channelName.ifBlank { channelName.ifBlank { "Голосовой канал" } }
        status.text = when (state.phase) {
            "connected" -> "В канале · ${state.participants.size} / 10"
            "reconnecting" -> "Восстанавливаем связь…"
            "connecting" -> "Подключаемся…"
            else -> "Звонок завершён"
        }
        error.text = state.error.orEmpty()
        error.visibility = if (state.error == null) View.GONE else View.VISIBLE
        val enabled = state.phase == "connected" && !state.busy && service != null
        listOf(microphone, camera, screen, speaker, deafen).forEach { it.isEnabled = enabled }
        flip.isEnabled = enabled && state.camera
        microphone.text = if (state.microphone) "Микрофон вкл." else "Микрофон выкл."
        camera.text = if (state.camera) "Камера вкл." else "Камера выкл."
        screen.text = if (state.screen) "Стоп показа" else "Показать экран"
        deafen.text = if (state.deafened) "Звук выключен" else "Звук включён"
        speaker.text = if (state.speaker) "Наушники" else "Динамик"
        listOf(fps, bitrate, codec, appAudio).forEach { it.isEnabled = !state.screen && !state.busy }
        if (!state.microphone) appAudio.isChecked = false
        appAudio.isEnabled = !state.screen && !state.busy && state.microphone
        retry.visibility = if (state.phase in setOf("ended", "error", "idle")) View.VISIBLE else View.GONE
        val currentRoom = service?.room
        if (currentRoom == null || state.phase !in setOf("connected", "reconnecting")) {
            disposeVideos()
            return
        }
        if (renderedRoom !== currentRoom) { disposeVideos(); renderedRoom = currentRoom }
        val ids = state.participants.map { it.id }
        tiles.keys.filter { it !in ids }.toList().forEach { id -> tiles.remove(id)?.dispose() }
        state.participants.forEach { person ->
            val tile = tiles.getOrPut(person.id) { VideoTile(this, currentRoom) }
            tile.bind(person.cameraTrack, person.username + if (person.local) " · вы" else "", person.mirror)
            tile.onFullscreen = { person.cameraTrack?.let { openFullscreen(currentRoom, it, person.username, person.mirror) } }
        }
        if (participantOrder != ids) {
            participantGrid.removeAllViews()
            ids.forEachIndexed { index, id ->
                participantGrid.addView(tiles.getValue(id), GridLayout.LayoutParams(GridLayout.spec(index / 2), GridLayout.spec(index % 2, 1f)).apply {
                    width = 0; height = dp(155); setMargins(dp(3), dp(3), dp(3), dp(3))
                })
            }
            participantOrder = ids
        }
        val sharing = state.participants.filter { it.hasScreen }
        val selected = sharing.firstOrNull { it.id == state.selectedScreenId }
        if (selected != null) {
            if (screenTile == null || screenTileIdentity != selected.id) {
                screenTile?.dispose()
                screenContainer.removeAllViews()
                screenTile = VideoTile(this, currentRoom)
                screenTileIdentity = selected.id
                screenContainer.addView(screenTile, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(255)))
            }
            screenTile?.bind(selected.screenTrack, "${selected.username} · экран", screen = true)
            screenTile?.onFullscreen = { selected.screenTrack?.let { openFullscreen(currentRoom, it, selected.username, false) } }
            screenContainer.visibility = View.VISIBLE
        } else {
            screenTile?.dispose(); screenTile = null; screenTileIdentity = null
            screenContainer.removeAllViews(); screenContainer.visibility = View.GONE
        }
        val choiceIds = sharing.map { it.id }
        if (choiceIds != screenChoiceIds) {
            screenChoices.removeAllViews()
            if (sharing.size > 1) sharing.forEach { person -> screenChoices.addView(button("Экран: ${person.username}") { service?.selectScreen(person.id) }) }
            screenChoiceIds = choiceIds
        }
        if (fullscreenTrack != null && state.participants.none { it.cameraTrack === fullscreenTrack || it.screenTrack === fullscreenTrack }) dismissFullscreen()
    }

    private fun requestScreen() {
        if (service == null || currentState.phase != "connected") return
        val desired = ScreenRequest(appAudio.isChecked, if (fps.selectedItemPosition == 1) 60 else 30, listOf(12_000_000, 24_000_000, 40_000_000)[bitrate.selectedItemPosition.coerceIn(0, 2)], listOf("h264", "vp9", "vp8")[codec.selectedItemPosition.coerceIn(0, 2)])
        screenRequest = desired
        val manager = getSystemService(MediaProjectionManager::class.java)
        try { screenConsent.launch(manager.createScreenCaptureIntent()) }
        catch (_: Exception) { screenRequest = null; notice("Системный выбор экрана недоступен.") }
    }

    private fun permission(action: String, permission: String, granted: () -> Unit) {
        if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) granted()
        else { pendingPermission = action; mediaPermission.launch(permission) }
    }

    private fun openFullscreen(room: Room, track: io.livekit.android.room.track.VideoTrack, username: String, mirror: Boolean) {
        dismissFullscreen()
        fullscreenTrack = track
        fullscreen = VideoTile.showFullscreen(this, room, track, username, mirror)
        fullscreen?.setOnDismissListener { fullscreen = null; fullscreenTrack = null }
    }

    private fun dismissFullscreen() { fullscreen?.dismiss(); fullscreen = null; fullscreenTrack = null }

    private fun disposeVideos() {
        dismissFullscreen()
        tiles.values.forEach { it.dispose() }
        tiles.clear()
        participantOrder = emptyList()
        if (::participantGrid.isInitialized) participantGrid.removeAllViews()
        screenTile?.dispose(); screenTile = null; screenTileIdentity = null
        screenChoiceIds = emptyList()
        if (::screenContainer.isInitialized) { screenContainer.removeAllViews(); screenContainer.visibility = View.GONE }
        if (::screenChoices.isInitialized) screenChoices.removeAllViews()
        renderedRoom = null
    }

    private fun text(value: String, size: Float, color: Int) = TextView(this).apply { text = value; textSize = size; setTextColor(color) }
    private fun button(value: String, action: () -> Unit) = Button(this).apply {
        text = value; textSize = 12f; isAllCaps = false; minHeight = dp(48)
        setTextColor(TEXT); backgroundTintList = ColorStateList.valueOf(Color.rgb(37, 45, 53))
        setPadding(dp(6), dp(3), dp(6), dp(3)); setOnClickListener { action() }
    }
    private fun spinner(values: List<String>) = Spinner(this).apply {
        adapter = object : ArrayAdapter<String>(this@CallActivity, android.R.layout.simple_spinner_item, values) {
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View = super.getView(position, convertView, parent).apply { (this as? TextView)?.setTextColor(TEXT) }
        }.also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        minimumHeight = dp(48)
        backgroundTintList = ColorStateList.valueOf(ACCENT)
        contentDescription = values.first()
    }
    private fun addControl(parent: GridLayout, button: Button, index: Int) {
        parent.addView(button, GridLayout.LayoutParams(GridLayout.spec(index / 3), GridLayout.spec(index % 3, 1f)).apply { width = 0; height = dp(54); setMargins(dp(2), dp(2), dp(2), dp(2)) })
    }
    private fun notice(message: String) { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }
    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private val CHANNEL_ID = Regex("^[A-Za-z0-9_-]{1,100}$")
        private val BACKGROUND = Color.rgb(17, 20, 27)
        private val TEXT = Color.rgb(222, 232, 226)
        private val MUTED = Color.rgb(139, 160, 151)
        private val ACCENT = Color.rgb(183, 236, 138)
    }
}
