package cloud.signal.android

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.TextUtils
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import io.livekit.android.room.Room
import io.livekit.android.room.track.VideoTrack
import livekit.org.webrtc.RendererCommon
import livekit.org.webrtc.SurfaceViewRenderer
import java.util.Locale
import kotlin.math.roundToInt

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
    private val placeholderContent = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setPadding(dp(8), dp(8), dp(8), dp(8))
    }
    private val initials = TextView(context).apply {
        gravity = Gravity.CENTER
        textSize = 28f
        includeFontPadding = false
        setTextColor(Color.WHITE)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        background = rounded(AVATAR_COLOR, dp(26).toFloat())
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    private val name = TextView(context).apply {
        setTextColor(Color.WHITE)
        textSize = 13f
        includeFontPadding = false
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
        setPadding(dp(10), dp(5), dp(10), dp(5))
        background = rounded(OVERLAY_COLOR, dp(8).toFloat())
    }
    private val mediaLabel = TextView(context).apply {
        setTextColor(SECONDARY_COLOR)
        textSize = 12f
        includeFontPadding = false
        gravity = Gravity.CENTER
        maxLines = 2
        ellipsize = TextUtils.TruncateAt.END
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    private val fullscreen = actionButton(context, R.drawable.ic_fullscreen).apply {
        contentDescription = "Открыть видео на весь экран"
        isEnabled = false
        visibility = View.GONE
        setOnClickListener { requestFullscreen() }
    }

    init {
        minimumHeight = preferredHeight(context)
        background = rounded(TILE_COLOR, dp(14).toFloat(), BORDER_COLOR)
        clipToOutline = true
        addView(placeholder, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        placeholder.addView(placeholderContent, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        placeholderContent.addView(initials, LinearLayout.LayoutParams(dp(56), dp(56)))
        placeholderContent.addView(mediaLabel, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(8)
        })
        addView(name, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply {
            marginStart = dp(10)
            bottomMargin = dp(10)
            marginEnd = dp(10)
        })
        addView(fullscreen, LayoutParams(dp(48), dp(48), Gravity.TOP or Gravity.END).apply {
            topMargin = dp(4)
            marginEnd = dp(4)
        })
        bind(null, "Участник")
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        val height = if (MeasureSpec.getMode(heightMeasureSpec) == MeasureSpec.UNSPECIFIED) minimumHeight else MeasureSpec.getSize(heightMeasureSpec)
        // The username owns a footer. The avatar and media status share only
        // the remaining area, rather than competing with absolute offsets.
        val nameWidth = (width - paddingLeft - paddingRight - dp(20)).coerceAtLeast(0)
        if (name.maxWidth != nameWidth) name.maxWidth = nameWidth
        name.measure(MeasureSpec.makeMeasureSpec(name.maxWidth, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
        val footer = name.measuredHeight + dp(16)
        (placeholder.layoutParams as LayoutParams).bottomMargin = footer
        val available = (height - paddingTop - paddingBottom - footer - dp(16)).coerceAtLeast(0)
        val statusLines = if (mediaLabel.lineHeight * 2 <= available) 2 else 1
        if (mediaLabel.maxLines != statusLines) mediaLabel.maxLines = statusLines
        mediaLabel.measure(
            MeasureSpec.makeMeasureSpec((width - paddingLeft - paddingRight - dp(16)).coerceAtLeast(0), MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(available, MeasureSpec.AT_MOST),
        )
        val avatarSize = minOf(dp(56), available - mediaLabel.measuredHeight - dp(8))
        val showAvatar = avatarSize >= dp(28)
        initials.visibility = if (showAvatar) View.VISIBLE else View.GONE
        if (showAvatar) {
            initials.layoutParams.width = avatarSize
            initials.layoutParams.height = avatarSize
            initials.setTextSize(TypedValue.COMPLEX_UNIT_PX, minOf(28f * resources.displayMetrics.scaledDensity, avatarSize * 0.48f))
        }
        (mediaLabel.layoutParams as LinearLayout.LayoutParams).topMargin = if (showAvatar) dp(8) else 0
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }

    /** Call on the UI thread. [username] comes from the account directory, not a LiveKit identity. */
    fun bind(track: VideoTrack?, username: String, mirror: Boolean = false, screen: Boolean = false) {
        if (disposed) return
        val visibleName = username.trim().ifEmpty { "Участник" }
        name.text = visibleName
        name.contentDescription = visibleName
        initials.text = initialsFor(visibleName)
        mediaLabel.text = if (screen) "Демонстрация экрана" else "Камера выключена"
        contentDescription = "$visibleName. " + if (track == null) mediaLabel.text else if (screen) "Демонстрация экрана" else "Камера"
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
            contentDescription = "${name.text}. Видео временно недоступно"
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

        /** Grid hosts can reserve more room when Android uses larger fonts. */
        fun preferredHeight(context: Context): Int {
            val extraScale = (context.resources.configuration.fontScale - 1f).coerceAtLeast(0f)
            return pixels(context, 155) + (pixels(context, 64) * extraScale).roundToInt()
        }

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
            onDismiss: (() -> Unit)? = null,
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
            dialog.setOnDismissListener {
                releaseRenderer()
                onDismiss?.invoke()
            }
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
                val gestures = GestureDetector(activity, object : GestureDetector.SimpleOnGestureListener() {
                    override fun onDown(event: MotionEvent): Boolean = true
                    override fun onDoubleTap(event: MotionEvent): Boolean { dialog.dismiss(); return true }
                })
                video.setOnTouchListener { view, event ->
                    val handled = gestures.onTouchEvent(event)
                    if (event.actionMasked == MotionEvent.ACTION_UP) view.performClick()
                    handled
                }
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
                val close = actionButton(activity, R.drawable.ic_fullscreen_exit).apply {
                    contentDescription = "Свернуть полноэкранное видео"
                    setOnClickListener { dialog.dismiss() }
                }
                root.addView(close, LayoutParams(pixels(activity, 48), pixels(activity, 48), Gravity.TOP or Gravity.END).apply {
                    topMargin = pixels(activity, 12)
                    marginEnd = pixels(activity, 12)
                })
                ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
                    val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
                    view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
                    insets
                }
                dialog.setContentView(root)
                dialog.setCanceledOnTouchOutside(false)
                dialog.show()
                dialog.window?.apply {
                    setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
                    addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        insetsController?.apply {
                            systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                            hide(WindowInsets.Type.systemBars())
                        }
                    } else {
                        @Suppress("DEPRECATION")
                        decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or
                            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
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

        private fun actionButton(context: Context, icon: Int): ImageButton = ImageButton(context).apply {
            setImageResource(icon)
            scaleType = ImageView.ScaleType.CENTER_INSIDE
            setPadding(pixels(context, 12), pixels(context, 12), pixels(context, 12), pixels(context, 12))
            background = rounded(OVERLAY_COLOR, pixels(context, 12).toFloat())
            isClickable = true
            isFocusable = true
            val selectable = android.util.TypedValue()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                context.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, selectable, true) &&
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
            // Labels can append "· вы" or "· экран". Account usernames
            // cannot contain the separator; it must not become an initial.
            .substringBefore('·')
            .trim()
            .split(Regex("\\s+"))
            .filter { it.isNotEmpty() }
            .take(2)
            .joinToString("") { word -> String(Character.toChars(word.codePointAt(0))) }
            .uppercase(Locale.ROOT)
    }
}
