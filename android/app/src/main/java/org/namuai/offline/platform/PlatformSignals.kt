package org.namuai.offline.platform

import android.app.Application
import android.content.ComponentCallbacks2
import android.content.res.Configuration
import android.os.PowerManager
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors

/**
 * Application-level thermal, memory-pressure and keyboard-shortcut signals.
 * They are registered on the Application (not on a view or Activity) so they
 * reach the JS controller even when no React screen is mounted (INF-007).
 */
object PlatformSignals {

    interface Listener {
        fun onThermalState(state: String)
        fun onMemoryPressure(level: String)
        fun onSendShortcut()
    }

    private val listeners = CopyOnWriteArraySet<Listener>()
    private val executor = Executors.newSingleThreadExecutor()
    @Volatile private var installed = false
    @Volatile var thermalState: String = "unknown"
        private set

    fun addListener(listener: Listener) {
        listeners.add(listener)
    }

    fun removeListener(listener: Listener) {
        listeners.remove(listener)
    }

    @Synchronized
    fun install(app: Application) {
        if (installed) return
        installed = true

        app.registerComponentCallbacks(object : ComponentCallbacks2 {
            override fun onTrimMemory(level: Int) {
                memoryLevel(level)?.let { mapped -> listeners.forEach { it.onMemoryPressure(mapped) } }
            }

            @Suppress("OVERRIDE_DEPRECATION")
            override fun onLowMemory() {
                listeners.forEach { it.onMemoryPressure("critical") }
            }

            override fun onConfigurationChanged(newConfig: Configuration) = Unit
        })

        // INF-008: listener based; thermal headroom is never polled.
        val power = app.getSystemService(PowerManager::class.java)
        if (power != null) {
            thermalState = mapThermal(power.currentThermalStatus)
            power.addThermalStatusListener(executor) { status ->
                val mapped = mapThermal(status)
                thermalState = mapped
                listeners.forEach { it.onThermalState(mapped) }
            }
        }
    }

    /** MainActivity forwards Ctrl/Cmd+Enter here (A11Y-002). */
    fun sendShortcut() {
        listeners.forEach { it.onSendShortcut() }
    }

    /** Contract §2 thermal mapping. */
    fun mapThermal(status: Int): String = when (status) {
        PowerManager.THERMAL_STATUS_NONE -> "nominal"
        PowerManager.THERMAL_STATUS_LIGHT, PowerManager.THERMAL_STATUS_MODERATE -> "fair"
        PowerManager.THERMAL_STATUS_SEVERE -> "serious"
        PowerManager.THERMAL_STATUS_CRITICAL,
        PowerManager.THERMAL_STATUS_EMERGENCY,
        PowerManager.THERMAL_STATUS_SHUTDOWN -> "critical"
        else -> "unknown"
    }

    /**
     * Contract §2: RUNNING_LOW and above → warning, RUNNING_CRITICAL/COMPLETE →
     * critical. TRIM_MEMORY_UI_HIDDEN is numerically above RUNNING_LOW but only
     * says "the UI is hidden", so it is not reported as memory pressure.
     */
    @Suppress("DEPRECATION")
    fun memoryLevel(level: Int): String? = when {
        level == ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN -> null
        level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL -> "critical"
        level >= ComponentCallbacks2.TRIM_MEMORY_COMPLETE -> "critical"
        level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW -> "warning"
        else -> null
    }
}
