package org.namuai.offline.core.transfer

/** Free-space seam. Android: StatFs on the model root volume. */
interface SpaceProbe {
    /** Bytes available to this app on the staging volume. May throw; callers treat that as 0. */
    fun freeBytes(): Long
}

/**
 * DL-009. With B = expected bytes and P = durable partial bytes a transfer or
 * resume needs `free >= (B - P) + 1 GiB`. Installed bytes are already excluded
 * from the reported free space and are never counted twice. While transferring,
 * and again before verification output and activation, pause with SPACE_LOW
 * when free space is below 256 MiB.
 */
object SpaceRule {
    const val HEADROOM_BYTES = 1024L * 1024 * 1024
    const val PAUSE_RESERVE_BYTES = 256L * 1024 * 1024

    fun requiredAdditionalBytes(expectedBytes: Long, partialBytes: Long): Long =
        maxOf(0L, expectedBytes - partialBytes) + HEADROOM_BYTES

    fun canStartOrResume(freeBytes: Long, expectedBytes: Long, partialBytes: Long): Boolean =
        freeBytes >= requiredAdditionalBytes(expectedBytes, partialBytes)

    fun reserveOk(freeBytes: Long): Boolean = freeBytes >= PAUSE_RESERVE_BYTES

    /** A failing probe is treated as "no space": the safe outcome preserves every file. */
    fun safeFree(probe: SpaceProbe): Long = try {
        maxOf(0L, probe.freeBytes())
    } catch (e: Exception) {
        0L
    }
}
