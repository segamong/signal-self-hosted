package cloud.signal.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.content.ContextCompat
import com.twilio.audioswitch.AudioDevice
import com.twilio.audioswitch.AudioDeviceChangeListener
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.ConnectOptions
import io.livekit.android.RoomOptions
import io.livekit.android.audio.ScreenAudioCapturer
import io.livekit.android.e2ee.BaseKeyProvider
import io.livekit.android.e2ee.E2EEOptions
import io.livekit.android.e2ee.E2EEState
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.track.CameraPosition
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoEncoding
import io.livekit.android.room.track.VideoQuality
import io.livekit.android.room.track.VideoTrack
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import io.livekit.android.util.LoggingLevel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import livekit.org.webrtc.RtpParameters
import livekit.org.webrtc.FrameCryptorKeyDerivationAlgorithm
import livekit.LivekitModels

data class CallParticipant(
    val id: String,
    val username: String,
    val local: Boolean,
    val microphone: Boolean,
    val cameraTrack: VideoTrack?,
    val screenTrack: VideoTrack?,
    val hasScreen: Boolean,
    val mirror: Boolean,
)

data class CallState(
    val channelId: String? = null,
    val channelName: String = "",
    val phase: String = "idle",
    val microphone: Boolean = false,
    val camera: Boolean = false,
    val screen: Boolean = false,
    val systemAudio: Boolean = false,
    val deafened: Boolean = false,
    val speaker: Boolean = false,
    val busy: Boolean = false,
    val participants: List<CallParticipant> = emptyList(),
    val selectedScreenId: String? = null,
    val error: String? = null,
)

/** One user-started call, owned by a foreground service rather than a WebView. */
class CallService : Service() {
    inner class LocalBinder : Binder() { val service: CallService get() = this@CallService }
    private val binder = LocalBinder()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val controls = Mutex()
    private var connectJob: Job? = null
    private var eventsJob: Job? = null
    private var membersJob: Job? = null
    private var controlScope: CoroutineScope? = null
    private var generation = 0L
    var room: Room? = null
        private set
    private var usernames: Map<String, String> = emptyMap()
    private var selectedScreenId: String? = null
    private var screenAudio: ScreenAudioCapturer? = null
    private var foreground = false
    private var callWakeLock: PowerManager.WakeLock? = null
    private var notificationSummary = ""
    private val audioDevicesListener: AudioDeviceChangeListener = { _, selected ->
        scope.launch {
            mutableState.value = mutableState.value.copy(speaker = selected is AudioDevice.Speakerphone)
        }
    }

    override fun onCreate() {
        super.onCreate()
        LiveKit.loggingLevel = LoggingLevel.OFF
        LiveKit.enableWebRTCLogging = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Звонок Сигнала", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Управление текущим голосовым звонком"
            })
        }
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_LEAVE) {
            leave()
            return START_NOT_STICKY
        }
        val id = intent?.getStringExtra(EXTRA_CHANNEL_ID)
        if (id == null || !CHANNEL_ID.matches(id)) {
            if (!foreground) stopSelf()
            return START_NOT_STICKY
        }
        // Start from a visible Activity, including for a listen-only call.
        // Android 17 also requires this service for background audio playback.
        try { updateForeground() } catch (_: Exception) {
            mutableState.value = CallState(phase = "error", error = "Не удалось запустить уведомление звонка. Откройте приложение и повторите.")
            stopSelf()
            return START_NOT_STICKY
        }
        connect(id, intent.getStringExtra(EXTRA_CHANNEL_NAME).orEmpty().take(100))
        return START_NOT_STICKY
    }

    /** A different channel is ignored until CallActivity obtains explicit confirmation. */
    fun connect(channelId: String, channelName: String, replace: Boolean = false) {
        if (!CHANNEL_ID.matches(channelId)) return
        val previous = mutableState.value
        val active = previous.channelId != null && previous.phase in ACTIVE_PHASES
        if (active && previous.channelId == channelId) return
        if (active && !replace) return
        val owner = ++generation
        connectJob?.cancel()
        releaseRoom()
        usernames = emptyMap()
        selectedScreenId = null
        mutableState.value = CallState(channelId, channelName, phase = "connecting")
        updateForeground()
        holdCallCpu()
        connectJob = scope.launch {
            try {
                val user = SignalApi.currentUser() ?: throw IllegalStateException("authentication")
                val credentials = SignalApi.joinChannel(channelId)
                val media = Uri.parse(credentials.url)
                require(media.scheme == "wss" && media.host == "13.143.172.92" && media.port == 9443 && media.userInfo == null && media.fragment == null) { "media origin" }
                if (owner != generation) return@launch
                usernames = mapOf(user.id to user.username)
                // Initialize native WebRTC before constructing its key provider.
                LiveKit.init(applicationContext)
                val keyProvider = BaseKeyProvider(
                    enableSharedKey = true,
                    discardFrameWhenCryptorNotReady = true,
                    keyDerivationAlgorithm = FrameCryptorKeyDerivationAlgorithm.PBKDF2,
                )
                if (!keyProvider.setSharedKey(credentials.encryptionKey)) throw SignalEncryptionException("Не удалось подготовить шифрование звонка. Подключение отменено.")
                val nextRoom = LiveKit.create(applicationContext, RoomOptions(
                    adaptiveStream = false,
                    dynacast = true,
                    e2eeOptions = E2EEOptions(keyProvider = keyProvider, encryptionType = LivekitModels.Encryption.Type.GCM),
                    videoTrackCaptureDefaults = LocalVideoTrackOptions(captureParams = VideoCaptureParameter(1920, 1080, 30)),
                    videoTrackPublishDefaults = VideoTrackPublishDefaults(videoEncoding = VideoEncoding(3_500_000, 30), videoCodec = "h264"),
                    screenShareTrackCaptureDefaults = LocalVideoTrackOptions(isScreencast = true, captureParams = VideoCaptureParameter(0, 0, 30, adaptOutputToDimensions = false)),
                    screenShareTrackPublishDefaults = screenPublishOptions(30, 24_000_000, "h264"),
                ), LiveKitOverrides(okHttpClient = ServerTls.httpClient))
                room = nextRoom
                controlScope = CoroutineScope(SupervisorJob(scope.coroutineContext[Job]) + Dispatchers.Main.immediate)
                nextRoom.audioSwitchHandler?.registerAudioDeviceChangeListener(audioDevicesListener)
                eventsJob = launch(start = CoroutineStart.UNDISPATCHED) {
                    nextRoom.events.collect { event ->
                        if (room !== nextRoom || owner != generation) return@collect
                        when (event) {
                            is RoomEvent.Reconnecting -> mutableState.value = mutableState.value.copy(phase = "reconnecting")
                            is RoomEvent.Reconnected -> {
                                mutableState.value = mutableState.value.copy(phase = "connected", error = null)
                                refreshMembers(channelId, owner)
                            }
                            is RoomEvent.ParticipantConnected -> refreshMembers(channelId, owner)
                            is RoomEvent.TrackE2EEStateEvent -> {
                                if (event.state in setOf(E2EEState.MISSING_KEY, E2EEState.ENCRYPTION_FAILED, E2EEState.DECRYPTION_FAILED, E2EEState.INTERNAL_ERROR)) {
                                    finishCall("Не удалось подтвердить шифрование медиа. Подключитесь к каналу снова.")
                                    return@collect
                                }
                            }
                            is RoomEvent.Disconnected -> {
                                val message = when (event.reason.name) {
                                    "ROOM_DELETED" -> "Состав или доступ к комнате изменился. Подключитесь снова для обновления шифрования."
                                    "PARTICIPANT_REMOVED" -> "Доступ к звонку завершён владельцем или администратором."
                                    else -> "Соединение завершено. Подключитесь к каналу снова."
                                }
                                finishCall(message)
                                return@collect
                            }
                            else -> Unit
                        }
                        syncRoom(nextRoom)
                    }
                }
                // Validate publication encryption before subscribing; a legacy
                // plaintext microphone must never play while an event is handled.
                nextRoom.connect(credentials.url, credentials.token, ConnectOptions(autoSubscribe = false))
                if (owner != generation || room !== nextRoom) return@launch
                if (nextRoom.e2eeManager?.enabled != true) throw SignalEncryptionException("Шифрование звонка не включилось. Подключение отменено.")
                mutableState.value = mutableState.value.copy(phase = "connected", error = null)
                refreshMembers(channelId, owner)
                syncRoom(nextRoom)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: SignalEncryptionException) {
                if (owner == generation) finishCall(error.message ?: "Не удалось подготовить защищённый звонок.")
            } catch (error: SignalApiException) {
                if (owner == generation) finishCall(if (error.status == 426) "Обновите приложение: сервер требует новую версию шифрования звонка." else "Не удалось подключиться к звонку. Проверьте вход в аккаунт и доступ к каналу.")
            } catch (_: Exception) {
                if (owner == generation) finishCall("Не удалось подключиться к звонку. Проверьте вход в аккаунт, доступ к каналу и соединение.")
            }
        }
    }

    private fun refreshMembers(channelId: String, owner: Long) {
        membersJob?.cancel()
        membersJob = scope.launch {
            try {
                val members = SignalApi.channelMembers(channelId)
                if (owner != generation) return@launch
                usernames = usernames + members.filterValues { USERNAME.matches(it) }
                room?.let(::syncRoom)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { /* Keep «Участник», never fall back to old SDK names. */ }
        }
    }

    private fun syncRoom(current: Room) {
        if (room !== current) return
        if (current.remoteParticipants.values.any { participant -> participant.trackPublications.values.any { it.encryptionType != LivekitModels.Encryption.Type.GCM } }) {
            finishCall("Участник использует версию без шифрования. Для звонка всем нужно обновить приложение или страницу.")
            return
        }
        val participants: List<Participant> = listOf(current.localParticipant) + current.remoteParticipants.values
        val sharing = participants.filter { it.getTrackPublication(Track.Source.SCREEN_SHARE)?.muted == false }
        if (sharing.none { it.identity?.value == selectedScreenId }) selectedScreenId = sharing.firstOrNull()?.identity?.value
        val deafened = mutableState.value.deafened
        for (participant in current.remoteParticipants.values) {
            for (publication in participant.trackPublications.values) {
                val screen = publication.source == Track.Source.SCREEN_SHARE || publication.source == Track.Source.SCREEN_SHARE_AUDIO
                val wanted = !screen || participant.identity?.value == selectedScreenId
                val remote = publication as? io.livekit.android.room.track.RemoteTrackPublication ?: continue
                if (remote.isDesired != wanted) remote.setSubscribed(wanted)
                if (wanted && remote.source == Track.Source.SCREEN_SHARE) remote.setVideoQuality(VideoQuality.HIGH)
                (publication.track as? RemoteAudioTrack)?.setVolume(if (deafened) 0.0 else 1.0)
            }
        }
        // A server mute also stops mixing local app audio into that mic stream.
        if (!current.localParticipant.isMicrophoneEnabled && screenAudio != null) detachScreenAudio(current)
        val items = participants.mapNotNull { participant ->
            val id = participant.identity?.value ?: return@mapNotNull null
            val camera = participant.getTrackPublication(Track.Source.CAMERA)
            val screen = participant.getTrackPublication(Track.Source.SCREEN_SHARE)
            val cameraTrack = camera?.takeIf { !it.muted }?.track as? VideoTrack
            CallParticipant(
                id = id,
                username = usernames[id]?.takeIf { USERNAME.matches(it) } ?: "Участник",
                local = participant === current.localParticipant,
                microphone = participant.isMicrophoneEnabled,
                cameraTrack = cameraTrack,
                screenTrack = screen?.takeIf { !it.muted }?.track as? VideoTrack,
                hasScreen = screen?.muted == false,
                mirror = participant === current.localParticipant && (cameraTrack as? LocalVideoTrack)?.options?.position == CameraPosition.FRONT,
            )
        }
        mutableState.value = mutableState.value.copy(
            microphone = current.localParticipant.isMicrophoneEnabled,
            camera = current.localParticipant.isCameraEnabled,
            screen = current.localParticipant.isScreenShareEnabled,
            systemAudio = screenAudio != null,
            participants = items,
            selectedScreenId = selectedScreenId,
        )
        updateForeground()
    }

    fun selectScreen(identity: String) {
        val current = room ?: return
        selectedScreenId = identity
        syncRoom(current)
    }

    fun setMicrophone(enabled: Boolean) = control("Не удалось изменить состояние микрофона.") { current ->
        if (enabled && ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) throw SecurityException()
        if (!enabled) detachScreenAudio(current)
        updateForeground(microphone = enabled)
        check(withContext(Dispatchers.IO) { current.localParticipant.setMicrophoneEnabled(enabled) })
    }

    fun setCamera(enabled: Boolean) = control("Не удалось изменить состояние камеры.") { current ->
        if (enabled && ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) throw SecurityException()
        updateForeground(camera = enabled)
        check(withContext(Dispatchers.IO) { current.localParticipant.setCameraEnabled(enabled) })
    }

    fun flipCamera() = control("Не удалось переключить камеру.") { current ->
        val track = current.localParticipant.getTrackPublication(Track.Source.CAMERA)?.track as? LocalVideoTrack ?: return@control
        val position = if (track.options.position == CameraPosition.FRONT) CameraPosition.BACK else CameraPosition.FRONT
        withContext(Dispatchers.IO) { track.switchCamera(position = position) }
    }

    fun startScreen(data: Intent, appAudio: Boolean, fps: Int, bitrate: Int, codec: String) = control("Не удалось начать показ экрана. Повторно выберите экран или приложение.") { current ->
        if (current.localParticipant.isScreenShareEnabled) return@control
        val selectedFps = if (fps == 60) 60 else 30
        val selectedBitrate = bitrate.takeIf { it in setOf(12_000_000, 24_000_000, 40_000_000) } ?: 24_000_000
        val selectedCodec = codec.takeIf { it in setOf("h264", "vp9", "vp8") } ?: "h264"
        val captureAppAudio = appAudio && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        if (captureAppAudio && !current.localParticipant.isMicrophoneEnabled) {
            mutableState.value = mutableState.value.copy(error = "Звук приложений передаётся вместе с микрофоном. Включите микрофон или начните показ без звука.")
            return@control
        }
        current.screenShareTrackCaptureDefaults = LocalVideoTrackOptions(isScreencast = true, captureParams = VideoCaptureParameter(0, 0, selectedFps, adaptOutputToDimensions = false))
        current.screenShareTrackPublishDefaults = screenPublishOptions(selectedFps, selectedBitrate, selectedCodec)
        // SDK starts its declared mediaProjection foreground service before it
        // obtains MediaProjection. Each data Intent is used only for this call.
        val success = withContext(Dispatchers.IO) {
            current.localParticipant.setScreenShareEnabled(true, ScreenCaptureParams(data, onStop = {
                scope.launch {
                    if (room === current) {
                        detachScreenAudio(current)
                        syncRoom(current)
                    }
                }
            }))
        }
        check(success)
        if (room !== current) return@control
        selectedScreenId = current.localParticipant.identity?.value
        if (appAudio && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                mutableState.value = mutableState.value.copy(error = "Экран передаётся без звука: разрешение микрофона отозвано.")
                return@control
            }
            val screenTrack = current.localParticipant.getTrackPublication(Track.Source.SCREEN_SHARE)?.track
            val microphone = current.localParticipant.getTrackPublication(Track.Source.MICROPHONE)?.track as? LocalAudioTrack
            val capturer = ScreenAudioCapturer.createFromScreenShareTrack(screenTrack)
            if (capturer != null && microphone != null) {
                capturer.gain = 0.5f
                screenAudio = capturer
                microphone.setAudioBufferCallback(capturer)
            } else {
                capturer?.releaseAudioResources()
                mutableState.value = mutableState.value.copy(error = "Экран передаётся без звука приложений: устройство не предоставило аудиозахват.")
            }
        }
    }

    fun stopScreen() = control("Не удалось остановить показ экрана.") { current ->
        detachScreenAudio(current)
        withContext(Dispatchers.IO) { current.localParticipant.setScreenShareEnabled(false) }
    }

    fun setDeafened(value: Boolean) {
        mutableState.value = mutableState.value.copy(deafened = value)
        room?.let(::syncRoom)
    }

    fun setSpeaker(value: Boolean) {
        val handler = room?.audioSwitchHandler ?: return
        val available = handler.availableAudioDevices
        val selected = if (value) available.firstOrNull { it is AudioDevice.Speakerphone }
        else available.firstOrNull { it is AudioDevice.BluetoothHeadset || it is AudioDevice.WiredHeadset }
            ?: available.firstOrNull { it is AudioDevice.Earpiece }
        if (selected == null) {
            mutableState.value = mutableState.value.copy(error = "Выбранное устройство вывода недоступно. Подключите наушники или выберите динамик.")
        } else handler.selectDevice(selected)
    }

    fun clearError() { mutableState.value = mutableState.value.copy(error = null) }

    private fun control(failure: String, operation: suspend (Room) -> Unit) {
        val operations = controlScope ?: return
        operations.launch {
            controls.withLock {
                val current = room ?: return@withLock
                if (mutableState.value.phase != "connected") return@withLock
                mutableState.value = mutableState.value.copy(busy = true, error = null)
                try { operation(current) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: SecurityException) {
                    if (room === current) mutableState.value = mutableState.value.copy(error = "Разрешите микрофон или камеру и включите их из открытого экрана звонка.")
                } catch (_: Exception) {
                    if (room === current) mutableState.value = mutableState.value.copy(error = failure)
                } finally {
                    if (room === current) {
                        mutableState.value = mutableState.value.copy(busy = false)
                        syncRoom(current)
                    }
                }
            }
        }
    }

    private fun detachScreenAudio(current: Room) {
        (current.localParticipant.getTrackPublication(Track.Source.MICROPHONE)?.track as? LocalAudioTrack)?.setAudioBufferCallback(null)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) screenAudio?.releaseAudioResources()
        screenAudio = null
    }

    private fun releaseRoom() {
        val previous = room
        room = null
        controlScope?.cancel()
        controlScope = null
        eventsJob?.cancel()
        eventsJob = null
        membersJob?.cancel()
        membersJob = null
        if (previous != null) {
            previous.audioSwitchHandler?.unregisterAudioDeviceChangeListener(audioDevicesListener)
            try { detachScreenAudio(previous) } catch (_: Exception) { screenAudio = null }
            try { previous.disconnect() } catch (_: Exception) { }
            try { previous.release() } catch (_: Exception) { }
        } else {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) screenAudio?.releaseAudioResources()
            screenAudio = null
        }
    }

    fun leave() { finishCall(null) }

    private fun finishCall(message: String?) {
        ++generation
        connectJob?.cancel()
        connectJob = null
        releaseRoom()
        releaseCallCpu()
        mutableState.value = CallState(phase = if (message == null) "ended" else "error", error = message)
        if (foreground) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
            else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        }
        foreground = false
        stopSelf()
    }

    // A foreground service alone does not keep packet processing running when
    // the display sleeps. The service owns this lock only for an active call.
    @SuppressLint("WakelockTimeout")
    private fun holdCallCpu() {
        if (callWakeLock?.isHeld == true) return
        callWakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:call")
            .apply { setReferenceCounted(false); acquire() }
    }

    private fun releaseCallCpu() {
        callWakeLock?.let { if (it.isHeld) it.release() }
        callWakeLock = null
    }

    private fun updateForeground(microphone: Boolean = mutableState.value.microphone, camera: Boolean = mutableState.value.camera) {
        val state = mutableState.value
        var type = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (microphone) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            if (camera) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        }
        val summary = listOf(state.channelId.orEmpty(), state.channelName, state.phase, microphone.toString(), camera.toString(), state.screen.toString()).joinToString("|")
        if (foreground && summary == notificationSummary) return
        val open = Intent(this, CallActivity::class.java).putExtra(EXTRA_CHANNEL_ID, state.channelId).putExtra(EXTRA_CHANNEL_NAME, state.channelName)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
        val pendingOpen = PendingIntent.getActivity(this, 1, open, pendingFlags)
        val pendingLeave = PendingIntent.getService(this, 2, Intent(this, CallService::class.java).setAction(ACTION_LEAVE), pendingFlags)
        val text = when (state.phase) {
            "connecting" -> "Подключаемся…"
            "reconnecting" -> "Восстанавливаем связь…"
            else -> buildString {
                append(if (microphone) "Микрофон включён" else "Микрофон выключен")
                if (camera) append(" · камера")
                if (state.screen) append(" · показ экрана")
            }
        }
        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        builder
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (state.channelName.isBlank()) "Звонок Сигнала" else "Сигнал · ${state.channelName}")
            .setContentText(text)
            .setContentIntent(pendingOpen)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_CALL)
            .addAction(Notification.Action.Builder(R.drawable.ic_notification, "Завершить", pendingLeave).build())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            @Suppress("DEPRECATION")
            builder.setPriority(Notification.PRIORITY_LOW)
        }
        val notification = builder.build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, notification, type)
        else startForeground(NOTIFICATION_ID, notification)
        foreground = true
        notificationSummary = summary
    }

    override fun onDestroy() {
        ++generation
        releaseRoom()
        releaseCallCpu()
        scope.cancel()
        if (mutableState.value.phase in ACTIVE_PHASES) mutableState.value = CallState(phase = "ended")
        super.onDestroy()
    }

    companion object {
        const val ACTION_LEAVE = "cloud.signal.android.LEAVE_CALL"
        const val EXTRA_CHANNEL_ID = "channelId"
        const val EXTRA_CHANNEL_NAME = "channelName"
        private const val CHANNEL = "signal_call"
        private const val NOTIFICATION_ID = 23010
        private val CHANNEL_ID = Regex("^[A-Za-z0-9_-]{1,100}$")
        private val USERNAME = Regex("^[A-Za-z0-9_-]{3,32}$")
        private val ACTIVE_PHASES = setOf("connecting", "connected", "reconnecting")
        private val mutableState = MutableStateFlow(CallState())
        val activeState: StateFlow<CallState> = mutableState.asStateFlow()

        private fun screenPublishOptions(fps: Int, bitrate: Int, codec: String) = VideoTrackPublishDefaults(
            videoEncoding = VideoEncoding(bitrate, fps),
            simulcast = false,
            videoCodec = codec,
            scalabilityMode = if (codec == "vp9") "L1T3" else null,
            degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION,
        )
    }
}
