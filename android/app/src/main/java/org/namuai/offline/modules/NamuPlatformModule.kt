package org.namuai.offline.modules

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.os.Build
import android.os.LocaleList
import android.os.PersistableBundle
import android.provider.Settings
import android.view.HapticFeedbackConstants
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableArray
import org.namuai.offline.BuildConfig
import org.namuai.offline.core.ErrorCodes
import org.namuai.offline.core.NamuException
import org.namuai.offline.platform.ChatDataDirectory
import org.namuai.offline.platform.DeviceProfile
import org.namuai.offline.platform.PlatformSignals
import org.namuai.offline.specs.NativeNamuPlatformSpec
import java.util.UUID
import java.util.concurrent.Executors

/** Device, lifecycle and small OS services (contract §2). */
class NamuPlatformModule(reactContext: ReactApplicationContext) :
    NativeNamuPlatformSpec(reactContext), PlatformSignals.Listener {

    private val executor = Executors.newSingleThreadExecutor()

    override fun initialize() {
        super.initialize()
        // Application-level signals: delivered even when no React screen is mounted (INF-007).
        PlatformSignals.addListener(this)
    }

    override fun invalidate() {
        PlatformSignals.removeListener(this)
        executor.shutdown()
        super.invalidate()
    }

    override fun getTypedExportedConstants(): Map<String, Any> = mapOf(
        "appVersion" to BuildConfig.VERSION_NAME,
        "appBuild" to BuildConfig.VERSION_CODE,
        "osName" to "android",
        "osVersion" to Build.VERSION.RELEASE,
        "deviceModel" to Build.MODEL, // coarse hardware identifier, not a device ID
        "isSimulator" to DeviceProfile.isProbablyEmulator(),
        "isInternalBuild" to BuildConfig.INTERNAL_BUILD,
    )

    override fun getDeviceProfile(promise: Promise) =
        executor.resolve(promise) { DeviceProfile.toJson(reactApplicationContext) }

    /** BCP-47 tags in user preference order. */
    override fun getPreferredLocales(): WritableArray {
        val out = Arguments.createArray()
        val locales = LocaleList.getDefault()
        for (i in 0 until locales.size()) out.pushString(locales.get(i).toLanguageTag())
        return out
    }

    /** DB-002: UUIDv4 from SecureRandom (java.util.UUID.randomUUID), lower case. */
    override fun randomUUID(): String = UUID.randomUUID().toString()

    override fun getThermalState(promise: Promise) = promise.resolve(PlatformSignals.thermalState)

    override fun getAvailableMemoryBytes(promise: Promise) =
        executor.resolve(promise) { DeviceProfile.availableMemoryBytes(reactApplicationContext).toDouble() }

    override fun prepareChatDataDirectory(promise: Promise) = executor.resolve(promise) {
        ChatDataDirectory.prepare(reactApplicationContext).absolutePath
    }

    override fun getChatDataSizeBytes(promise: Promise) = executor.resolve(promise) {
        ChatDataDirectory.sizeBytes(reactApplicationContext).toDouble()
    }

    override fun deleteChatData(promise: Promise) = executor.resolve(promise) {
        if (!ChatDataDirectory.deleteAll(reactApplicationContext)) {
            throw NamuException(ErrorCodes.STORAGE_WRITE_FAILED, "chat data could not be removed")
        }
    }

    /** SEC-007: only ever called after an explicit user action; content is flagged sensitive. */
    override fun copyToClipboard(text: String) {
        UiThreadUtil.runOnUiThread {
            val clipboard = reactApplicationContext.getSystemService(ClipboardManager::class.java)
            if (clipboard != null) {
                val clip = ClipData.newPlainText("", text)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    clip.description.extras = PersistableBundle().apply {
                        putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
                    }
                }
                clipboard.setPrimaryClip(clip)
            }
        }
    }

    /** DS-004: explicit actions and terminal success/error only. Needs no VIBRATE permission. */
    override fun haptic(kind: String) {
        UiThreadUtil.runOnUiThread {
            val view = reactApplicationContext.currentActivity?.window?.decorView
            if (view != null) {
                val constant = when {
                    kind == "success" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> HapticFeedbackConstants.CONFIRM
                    kind == "error" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> HapticFeedbackConstants.REJECT
                    kind == "error" -> HapticFeedbackConstants.LONG_PRESS
                    else -> HapticFeedbackConstants.VIRTUAL_KEY
                }
                view.performHapticFeedback(constant)
            }
        }
    }

    /** DS-004: "Remove animations" sets the animator duration scale to 0. */
    override fun isReduceMotionEnabled(promise: Promise) {
        val scale = Settings.Global.getFloat(
            reactApplicationContext.contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        )
        promise.resolve(scale == 0f)
    }

    // ---- PlatformSignals.Listener → generated event emitters -------------------------------------

    override fun onThermalState(state: String) {
        if (mEventEmitterCallback == null) return
        emitOnThermalStateChanged(Arguments.createMap().apply { putString("state", state) })
    }

    override fun onMemoryPressure(level: String) {
        if (mEventEmitterCallback == null) return
        emitOnMemoryPressure(Arguments.createMap().apply { putString("level", level) })
    }

    /** A11Y-002: hardware Ctrl/Cmd+Enter. */
    override fun onSendShortcut() {
        if (mEventEmitterCallback == null) return
        emitOnSendShortcut(Arguments.createMap().apply { putString("source", "hardware-keyboard") })
    }
}
