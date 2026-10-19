package cloud.signal.android

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import io.livekit.android.room.Room
import io.livekit.android.room.track.VideoTrack
import livekit.org.webrtc.RendererCommon
import livekit.org.webrtc.SurfaceViewRenderer
import java.util.Locale

/** A view owns its renderer, while the call owns the video track and room. */
class VideoTile(context: Context, private val room: Room) : FrameLayout(context) {
    private var boundTrack: VideoTrack? = null
    private var renderer: SurfaceViewRenderer? = null
    private var mirrored = false
    private var disposed = false

    var onFullscreen: (() -> Unit)? = null
        set(value) {
            field = value
            fullscreen.isEnabled = value != null && boundTrack != null && !disposed
            fullscreen.alpha = if (fullscreen.isEnabled) 1f else 0.45f
        }

    private val placeholder = FrameLayout(context).apply {
        setBackgroundColor(TILE_COLOR)
    }
    private val initials = TextView(context).apply {
        gravity = Gravity.CENTER
        textSize = 32f
        setTextColor(Color.WHITE)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        background = rounded(AVATAR_COLOR, dp(26).toFloat())
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    private val name = TextView(context).apply {
        setTextColor(Color.WHITE)
        textSize = 13f
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
        setPadding(dp(10), dp(5), dp(10), dp(5))
        background = rounded(OVERLAY_COLOR, dp(8).toFloat())
    }
    private val mediaLabel = TextView(context).apply {
        setTextColor(SECONDARY_COLOR)
        textSize = 12f
        gravity = Gravity.CENTER
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    private val fullscreen = actionButton(context, "⛶").apply {
        contentDescription = "Открыть видео на весь экран"
        isEnabled = false
        visibility = View.GONE
        setOnClickListener { requestFullscreen() }
    }

    init {
        minimumHeight = dp(156)
        background = rounded(TILE_COLOR, dp(14).toFloat(), BORDER_COLOR)
        clipToOutline = true
        addView(placeholder, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        placeholder.addView(initials, LayoutParams(dp(72), dp(72), Gravity.CENTER).apply {
            bottomMargin = dp(18)
        })
        placeholder.addView(mediaLabel, LayoutParams(LayoutParams.MATCH_PARENT, dp(24), Gravity.CENTER).apply {
            topMargin = dp(76)
        })
        addView(name, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply {
            marginStart = dp(10)
            bottomMargin = dp(10)
            marginEnd = dp(64)
        })
        addView(fullscreen, LayoutParams(dp(48), dp(48), Gravity.TOP or Gravity.END).apply {
            topMargin = dp(4)
            marginEnd = dp(4)
        })
        bind(null, "Участник")
    }

    /** Call on the UI thread. [username] comes from the account directory, not a LiveKit identity. */
    fun bind(track: VideoTrack?, username: String, mirror: Boolean = false, screen: Boolean = false) {
        if (disposed) return
        val visibleName = username.trim().ifEmpty { "Участник" }
        name.text = visibleName
        name.contentDescription = visibleName
        initials.text = initialsFor(visibleName)
        mediaLabel.text = if (screen) "Демонстрация экрана" else "Камера выключена"
        fullscreen.contentDescription = if (screen) {
            "Демонстрация экрана $visibleName на весь экран"
        } else {
            "Камера $visibleName на весь экран"
        }
        mirrored = mirror && !screen
        if (boundTrack !== track) {
            detachRenderer()
            boundTrack = track
        }
        renderer?.setMirror(mirrored)
        if (track != null && renderer == null && isAttachedToWindow) attachRenderer()
        placeholder.visibility = if (renderer == null) View.VISIBLE else View.GONE
        fullscreen.visibility = if (track == null) View.GONE else View.VISIBLE
        fullscreen.isEnabled = track != null && onFullscreen != null
        fullscreen.alpha = if (fullscreen.isEnabled) 1f else 0.45f
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (!disposed && boundTrack != null && renderer == null) attachRenderer()
    }

    override fun onDetachedFromWindow() {
        detachRenderer()
        super.onDetachedFromWindow()
    }

    /** Remove only this view's sink. Other renderers and call audio stay connected. */
    fun dispose() {
        if (disposed) return
        disposed = true
        detachRenderer()
        boundTrack = null
        onFullscreen = null
        fullscreen.visibility = View.GONE
    }

    private fun requestFullscreen() {
        if (!disposed && boundTrack != null) onFullscreen?.invoke()
    }

    private fun attachRenderer() {
        val track = boundTrack ?: return
        if (disposed || renderer != null) return
        val video = SurfaceViewRenderer(context)
        try {
            room.initVideoRenderer(video)
            video.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
            video.setEnableHardwareScaler(false)
            video.setMirror(mirrored)
            video.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
                override fun onDown(event: MotionEvent): Boolean = true
                override fun onDoubleTap(event: MotionEvent): Boolean {
                    requestFullscreen()
                    return true
                }
            })
            video.setOnTouchListener { view, event ->
                val handled = gestures.onTouchEvent(event)
                if (event.actionMasked == MotionEvent.ACTION_UP) view.performClick()
                handled
            }
            addView(video, 1, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
            renderer = video
            track.addRenderer(video)
            placeholder.visibility = View.GONE
        } catch (_: Exception) {
            // Reconnects may invalidate a track between the event and the next view update.
            runCatching { track.removeRenderer(video) }
            renderer = null
            removeView(video)
            runCatching { video.release() }
            placeholder.visibility = View.VISIBLE
            mediaLabel.text = "Видео временно недоступно"
        }
    }

    private fun detachRenderer() {
        val video = renderer ?: return
        renderer = null
        runCatching { boundTrack?.removeRenderer(video) }
        removeView(video)
        runCatching { video.release() }
        placeholder.visibility = View.VISIBLE
    }

    private fun dp(value: Int): Int = pixels(context, value)

    companion object {
        private val TILE_COLOR = Color.rgb(29, 31, 38)
        private val BORDER_COLOR = Color.rgb(50, 53, 65)
        private val AVATAR_COLOR = Color.rgb(91, 103, 190)
        private val SECONDARY_COLOR = Color.rgb(174, 180, 199)
        private val OVERLAY_COLOR = Color.argb(220, 19, 21, 28)

        /**
         * The caller can dismiss the returned dialog when its call or publication ends.
         * Back, the close button, and Activity destruction release this extra renderer.
         */
        fun showFullscreen(
            activity: Activity,
            room: Room,
            track: VideoTrack,
            username: String,
            mirror: Boolean = false,
        ): Dialog? {
            if (activity.isFinishing || activity.isDestroyed) return null
            val dialog = Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
            val root = FrameLayout(activity).apply { setBackgroundColor(Color.BLACK) }
            val video = SurfaceViewRenderer(activity)
            var attached = false
            var released = false
            fun releaseRenderer() {
                if (released) return
                released = true
                if (attached) runCatching { track.removeRenderer(video) }
                root.removeView(video)
                runCatching { video.release() }
            }
            dialog.setOnDismissListener { releaseRenderer() }
            // A dialog's view detaches when its Activity is destroyed, too.
            root.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
                override fun onViewAttachedToWindow(view: View) = Unit
                override fun onViewDetachedFromWindow(view: View) { releaseRenderer() }
            })
            try {
                room.initVideoRenderer(video)
                video.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
                video.setEnableHardwareScaler(false)
                video.setMirror(mirror)
                video.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                root.addView(video, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
                val visibleName = username.trim().ifEmpty { "Участник" }
                val title = TextView(activity).apply {
                    text = visibleName
                    setTextColor(Color.WHITE)
                    textSize = 15f
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                    setPadding(pixels(activity, 14), pixels(activity, 9), pixels(activity, 14), pixels(activity, 9))
                    background = rounded(OVERLAY_COLOR, pixels(activity, 10).toFloat())
                }
                root.addView(title, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply {
                    marginStart = pixels(activity, 16)
                    marginEnd = pixels(activity, 16)
                    bottomMargin = pixels(activity, 20)
                })
                val close = actionButton(activity, "×").apply {
                    contentDescription = "Закрыть полноэкранное видео"
                    setOnClickListener { dialog.dismiss() }
                }
                root.addView(close, LayoutParams(pixels(activity, 48), pixels(activity, 48), Gravity.TOP or Gravity.END).apply {
                    topMargin = pixels(activity, 12)
                    marginEnd = pixels(activity, 12)
                })
                dialog.setContentView(root)
                dialog.setCanceledOnTouchOutside(false)
                dialog.show()
                dialog.window?.apply {
                    setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
                    addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    insetsController?.apply {
                        systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                        hide(WindowInsets.Type.systemBars())
                    }
                }
                track.addRenderer(video)
                attached = true
                return dialog
            } catch (_: Exception) {
                // Do not expose SDK errors, which can contain a signaling URL or token.
                runCatching { track.removeRenderer(video) }
                releaseRenderer()
                if (dialog.isShowing) dialog.dismiss()
                return null
            }
        }

        private fun actionButton(context: Context, glyph: String): TextView = TextView(context).apply {
            text = glyph
            gravity = Gravity.CENTER
            textSize = 27f
            setTextColor(Color.WHITE)
            background = rounded(OVERLAY_COLOR, pixels(context, 12).toFloat())
            isClickable = true
            isFocusable = true
            val selectable = android.util.TypedValue()
            if (context.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, selectable, true) &&
                selectable.resourceId != 0
            ) {
                foreground = context.getDrawable(selectable.resourceId)
            }
        }

        private fun rounded(color: Int, radius: Float, strokeColor: Int? = null): GradientDrawable =
            GradientDrawable().apply {
                setColor(color)
                cornerRadius = radius
                if (strokeColor != null) setStroke(1, strokeColor)
            }

        private fun pixels(context: Context, value: Int): Int =
            (value * context.resources.displayMetrics.density + 0.5f).toInt()

        private fun initialsFor(username: String): String = username
            .split(Regex("\\s+"))
            .filter { it.isNotEmpty() }
            .take(2)
            .joinToString("") { word -> String(Character.toChars(word.codePointAt(0))) }
            .uppercase(Locale.ROOT)
    }
}
