package org.namuai.offline.core.transfer

import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

sealed class RetryDecision {
    class After(val delayMs: Long) : RetryDecision()

    /** Automatic retries are exhausted → failed/TRANSFER_RETRY, user retry required. */
    object GiveUp : RetryDecision()
}

/**
 * DL-007 / contract §6.1. Transient I/O, 408, 429 and 5xx are retried after
 * 2, 5, 15, 30 and 60 s with up to +20 % jitter; `Retry-After` is honoured up
 * to 15 minutes. All five back-off steps are used: the transfer becomes
 * user-retry-required when a failure arrives after the fifth automatic retry
 * has been consumed. Durable progress resets the counter (done by the engine).
 */
class RetryPolicy(private val random: () -> Double = { Math.random() }) {

    /**
     * @param retriesAlreadyUsed consecutive automatic retries consumed so far (journal retry_count).
     * @param retryAfterMs parsed `Retry-After`, or null.
     */
    fun next(retriesAlreadyUsed: Int, retryAfterMs: Long?): RetryDecision {
        if (retriesAlreadyUsed < 0 || retriesAlreadyUsed >= BACKOFF_SECONDS.size) return RetryDecision.GiveUp
        val base = BACKOFF_SECONDS[retriesAlreadyUsed] * 1000L
        val r = random().coerceIn(0.0, 1.0)
        val jittered = base + (base * MAX_JITTER * r).toLong()
        val serverDelay = retryAfterMs?.coerceIn(0L, MAX_RETRY_AFTER_MS) ?: 0L
        return RetryDecision.After(maxOf(jittered, serverDelay))
    }

    companion object {
        val BACKOFF_SECONDS = intArrayOf(2, 5, 15, 30, 60)
        const val MAX_AUTOMATIC_RETRIES = 5
        const val MAX_JITTER = 0.20
        const val MAX_RETRY_AFTER_MS = 15L * 60 * 1000

        /** `Retry-After`: delta-seconds or an HTTP-date. Null when absent/unparseable. */
        fun parseRetryAfter(header: String?, nowMs: Long): Long? {
            val value = header?.trim() ?: return null
            if (value.isEmpty()) return null
            if (value.all { it in '0'..'9' }) {
                if (value.length > 9) return MAX_RETRY_AFTER_MS
                return value.toLong() * 1000L
            }
            return try {
                val at = ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME)
                maxOf(0L, at.toInstant().toEpochMilli() - nowMs)
            } catch (e: DateTimeParseException) {
                null
            }
        }

        fun isRetryableStatus(code: Int): Boolean = code == 408 || code == 429 || code in 500..599
    }
}
