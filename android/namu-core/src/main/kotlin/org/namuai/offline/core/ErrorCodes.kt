package org.namuai.offline.core

/**
 * Stable codes shared with JS: PRD section 17 plus the three service codes of
 * native-contract §6.5. User-visible errors carry ONLY these codes — never
 * headers, stack traces or filesystem paths (PRD §17, OBS-001).
 */
object ErrorCodes {
    const val DEVICE_INELIGIBLE = "DEVICE_INELIGIBLE"
    const val SPACE_LOW = "SPACE_LOW"
    const val NETWORK_WAIT = "NETWORK_WAIT"
    const val TRANSFER_RETRY = "TRANSFER_RETRY"
    const val TRANSFER_RESTART = "TRANSFER_RESTART"
    const val SIGNATURE_INVALID = "SIGNATURE_INVALID"
    const val FILE_DAMAGED = "FILE_DAMAGED"
    const val MODEL_INCOMPATIBLE = "MODEL_INCOMPATIBLE"
    const val MODEL_LOAD_FAILED = "MODEL_LOAD_FAILED"
    const val MEMORY_LOW = "MEMORY_LOW"
    const val DEVICE_HOT = "DEVICE_HOT"
    const val STORAGE_WRITE_FAILED = "STORAGE_WRITE_FAILED"
    const val DATABASE_RECOVERY = "DATABASE_RECOVERY"

    const val ENGINE_BUSY = "ENGINE_BUSY"
    const val NOT_FOUND = "NOT_FOUND"
    const val INVALID_STATE = "INVALID_STATE"

    /** Codes JS may hand to activate(pass=false); anything else becomes MODEL_LOAD_FAILED. */
    val SELF_TEST_FAILURE_CODES: Set<String> =
        setOf(MODEL_LOAD_FAILED, MODEL_INCOMPATIBLE, MEMORY_LOW, DEVICE_HOT, FILE_DAMAGED)
}

/** Thrown by the service facade; the React module maps [code] to the promise rejection code. */
class NamuException(val code: String, detail: String) : Exception(detail)
