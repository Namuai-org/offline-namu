package org.namuai.offline.core.descriptor

import com.google.crypto.tink.subtle.Ed25519Verify
import java.security.GeneralSecurityException

/** Seam so the JVM build uses `tink` and the app uses `tink-android` (same API). */
interface Ed25519Verifier {
    /** @return true only when [signature64] is a valid Ed25519 signature of [message]. */
    fun verify(publicKey32: ByteArray, message: ByteArray, signature64: ByteArray): Boolean
}

/** Tink subtle Ed25519 (PRD §2 "Integrity": Android Tink). */
class TinkEd25519Verifier : Ed25519Verifier {
    override fun verify(publicKey32: ByteArray, message: ByteArray, signature64: ByteArray): Boolean {
        if (publicKey32.size != 32 || signature64.size != 64) return false
        return try {
            Ed25519Verify(publicKey32).verify(signature64, message)
            true
        } catch (e: GeneralSecurityException) {
            false
        } catch (e: IllegalArgumentException) {
            false
        }
    }
}
