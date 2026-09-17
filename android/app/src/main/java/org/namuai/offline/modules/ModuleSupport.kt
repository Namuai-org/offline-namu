package org.namuai.offline.modules

import com.facebook.react.bridge.Promise
import org.namuai.offline.core.ErrorCodes
import org.namuai.offline.core.NamuException
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException

/**
 * Runs a native call off the JS and main threads and maps failures to the
 * contract's `code` strings (§6.5). The rejection message is the code itself:
 * no stack traces, headers or filesystem paths ever reach JS (PRD §17).
 */
internal fun <T> ExecutorService.resolve(promise: Promise, block: () -> T) {
    try {
        execute {
            try {
                val value = block()
                promise.resolve(if (value is Unit) null else value)
            } catch (e: NamuException) {
                promise.reject(e.code, e.code)
            } catch (e: IOException) {
                promise.reject(ErrorCodes.STORAGE_WRITE_FAILED, ErrorCodes.STORAGE_WRITE_FAILED)
            } catch (e: Exception) {
                promise.reject(ErrorCodes.INVALID_STATE, ErrorCodes.INVALID_STATE)
            }
        }
    } catch (e: RejectedExecutionException) {
        promise.reject(ErrorCodes.INVALID_STATE, ErrorCodes.INVALID_STATE) // module already invalidated
    }
}
