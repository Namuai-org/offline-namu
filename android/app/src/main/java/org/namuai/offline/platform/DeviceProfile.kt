package org.namuai.offline.platform

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.StatFs
import org.namuai.offline.BuildConfig
import org.namuai.offline.core.json.JsonOut
import org.namuai.offline.core.transfer.DeviceEligibility

/** Contract §2 device profile (DEV-001…DEV-003). Coarse facts only; no identifiers. */
object DeviceProfile {
    /** DEV-002: conservative eligibility filter on reported physical memory. */
    const val MIN_PHYSICAL_MEMORY_BYTES = 5_000_000_000L

    fun physicalMemoryBytes(context: Context): Long = memoryInfo(context)?.totalMem ?: 0L

    fun availableMemoryBytes(context: Context): Long = memoryInfo(context)?.availMem ?: 0L

    private fun memoryInfo(context: Context): ActivityManager.MemoryInfo? {
        val manager = context.getSystemService(ActivityManager::class.java) ?: return null
        return ActivityManager.MemoryInfo().also { manager.getMemoryInfo(it) }
    }

    fun isProbablyEmulator(): Boolean =
        Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.contains("emulator") ||
            Build.HARDWARE.contains("goldfish") ||
            Build.HARDWARE.contains("ranchu") ||
            Build.MODEL.contains("sdk_gphone") ||
            Build.MODEL.contains("Emulator") ||
            Build.PRODUCT.contains("sdk")

    /** arm64-v8a; internal builds on an emulator also accept x86_64 (contract §2). */
    fun abiSupported(): Boolean {
        val abis = Build.SUPPORTED_64_BIT_ABIS
        if (abis.contains("arm64-v8a")) return true
        return BuildConfig.INTERNAL_BUILD && isProbablyEmulator() && abis.contains("x86_64")
    }

    fun freeDiskBytes(context: Context): Long = try {
        StatFs(context.noBackupFilesDir.absolutePath).availableBytes
    } catch (e: RuntimeException) {
        0L
    }

    fun toJson(context: Context): String = JsonOut.stringify(
        linkedMapOf(
            "physicalMemoryBytes" to physicalMemoryBytes(context),
            "logicalCpuCount" to Runtime.getRuntime().availableProcessors().toLong(),
            "freeDiskBytes" to freeDiskBytes(context),
            "osSupported" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q),
            "abiSupported" to abiSupported(),
            "metalSupported" to false, // DEV-004: Android inference is CPU only
            // The listener API exists on every supported OS (API 29+); a device whose HAL
            // reports nothing stays at `nominal`, which is why QA-003 needs measured runs.
            "thermalApiAvailable" to true,
        ),
    )
}

/**
 * Native preflight for TransferService.start (DEV-002, DEV-003): the JS check
 * is not the only gate. Internal builds on an emulator are exempt so the
 * pipeline can be exercised with the small fixture model (REL-001).
 */
class AndroidEligibility(context: Context) : DeviceEligibility {
    private val appContext = context.applicationContext

    override fun isEligible(): Boolean {
        if (BuildConfig.INTERNAL_BUILD && DeviceProfile.isProbablyEmulator()) return DeviceProfile.abiSupported()
        return DeviceProfile.abiSupported() &&
            DeviceProfile.physicalMemoryBytes(appContext) >= DeviceProfile.MIN_PHYSICAL_MEMORY_BYTES
    }
}
