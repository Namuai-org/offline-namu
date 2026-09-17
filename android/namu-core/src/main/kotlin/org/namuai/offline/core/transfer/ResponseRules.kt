package org.namuai.offline.core.transfer

import org.namuai.offline.core.ErrorCodes

/** The response facts the HTTP rules look at. Header values are never logged or surfaced. */
data class HttpFacts(
    val code: Int,
    val contentLength: String?,
    val contentRange: String?,
    val etag: String?,
    val contentEncoding: String?,
    val retryAfterMs: Long?,
)

sealed class ResponseAction {
    /** 200 to a fresh GET: write from offset 0. */
    class AcceptFresh(val strongEtag: String?) : ResponseAction()

    /** Valid 206: append at the committed offset. */
    object AcceptResume : ResponseAction()

    /** 200 to a Range request: truncate to 0, flag restartedFromZero, then use this body as fresh. */
    class FreshAfterTruncate(val strongEtag: String?) : ResponseAction()

    /** Discard this response, truncate to 0 and issue a fresh GET. */
    object RestartFromZero : ResponseAction()

    /** 416 while the local file is complete: go straight to verification. */
    object VerifyLocalFile : ResponseAction()

    class Transient(val retryAfterMs: Long?) : ResponseAction()
    class Fatal(val code: String, val deleteStaging: Boolean) : ResponseAction()
}

/**
 * Pure decision table of contract §6.2 (DL-003). B = expected bytes,
 * P = committed bytes; `resume` means the request carried Range + If-Range.
 */
object ResponseRules {

    fun isStrongEtag(etag: String?): Boolean =
        etag != null && etag.length >= 2 && etag.startsWith("\"") && etag.endsWith("\"")

    fun strongOrNull(etag: String?): String? = if (isStrongEtag(etag)) etag else null

    fun classify(
        resume: Boolean,
        committedBytes: Long,
        expectedBytes: Long,
        storedEtag: String?,
        localLength: Long,
        facts: HttpFacts,
    ): ResponseAction {
        val code = facts.code
        if (RetryPolicy.isRetryableStatus(code)) return ResponseAction.Transient(facts.retryAfterMs)

        if (code == 200 || code == 206) {
            val encoding = facts.contentEncoding?.trim()?.lowercase()
            if (!encoding.isNullOrEmpty() && encoding != "identity") {
                // A transformed body can never match the signed digest; do not spend the transfer.
                return ResponseAction.Fatal(ErrorCodes.TRANSFER_RETRY, deleteStaging = false)
            }
        }

        if (code == 200) {
            val declared = facts.contentLength
            if (declared != null && declared.trim().toLongOrNull() != expectedBytes) {
                // The origin does not hold the signed object (T07: oversized declared length).
                return ResponseAction.Fatal(ErrorCodes.FILE_DAMAGED, deleteStaging = true)
            }
            val strong = strongOrNull(facts.etag)
            return if (resume) ResponseAction.FreshAfterTruncate(strong) else ResponseAction.AcceptFresh(strong)
        }

        if (code == 206) {
            if (!resume) return ResponseAction.Transient(null) // never asked for a range
            val expectedRange = "bytes $committedBytes-${expectedBytes - 1}/$expectedBytes"
            val rangeOk = facts.contentRange?.trim() == expectedRange
            val etagOk = facts.etag == null || facts.etag == storedEtag
            val declared = facts.contentLength
            val lengthOk = declared == null || declared.trim().toLongOrNull() == expectedBytes - committedBytes
            return if (rangeOk && etagOk && lengthOk) ResponseAction.AcceptResume else ResponseAction.RestartFromZero
        }

        if (code == 416) {
            if (!resume) return ResponseAction.Fatal(ErrorCodes.TRANSFER_RETRY, deleteStaging = false)
            return if (localLength == expectedBytes) ResponseAction.VerifyLocalFile else ResponseAction.RestartFromZero
        }

        if (code in 400..499) {
            // Authorization and other client errors never auto-retry (DL-007).
            return ResponseAction.Fatal(ErrorCodes.TRANSFER_RETRY, deleteStaging = false)
        }
        // 1xx/other 2xx/unhandled 3xx: a protocol surprise, retried like a transport failure.
        return ResponseAction.Transient(null)
    }
}
