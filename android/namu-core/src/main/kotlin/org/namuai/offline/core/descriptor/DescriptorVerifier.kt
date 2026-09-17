package org.namuai.offline.core.descriptor

import org.namuai.offline.core.ErrorCodes
import org.namuai.offline.core.json.JsonValue
import org.namuai.offline.core.json.StrictJson
import org.namuai.offline.core.json.StrictJsonException
import org.namuai.offline.core.json.integer
import org.namuai.offline.core.json.string
import org.namuai.offline.core.json.stringArray
import org.namuai.offline.core.util.Hex
import java.security.MessageDigest
import java.time.DateTimeException
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.util.Base64

enum class DescriptorSource(val wire: String) {
    BUNDLED("bundled"),
    UPDATE("update");

    companion object {
        fun fromWire(value: String): DescriptorSource? = values().firstOrNull { it.wire == value }
    }
}

data class ReleaseKey(val keyId: String, val publicKeyB64: String)

/** Accepted architecture/quantization pairs (contract §4, REL-001 fixture profile). */
data class CompatibilityProfile(val architectures: Set<String>, val quantizations: Set<String>) {
    companion object {
        val PRODUCTION = CompatibilityProfile(setOf("cohere2"), setOf("Q4_K_M"))

        /** `.internal` builds only. */
        val INTERNAL = CompatibilityProfile(
            setOf("cohere2", "llama"),
            setOf("Q4_K_M", "Q8_0", "F16", "F32"),
        )
    }
}

data class Descriptor(
    val schema: Long,
    val sequence: Long,
    val modelId: String,
    val artifactVersion: String,
    val path: String,
    val bytes: Long,
    val sha256: String,
    val upstreamRepo: String,
    val upstreamRevision: String,
    val upstreamFilename: String,
    val architecture: String,
    val quantization: String,
    val runtimeBuildIds: List<String>,
    val minAppBuild: Long,
    val maxAppBuild: Long,
    val promptVersion: String,
    val licenseNoticeId: String,
    val issuedAtMs: Long,
    val expiresAtMs: Long,
)

class VerifyContext(
    val keys: List<ReleaseKey>,
    val source: DescriptorSource,
    val appBuild: Long,
    val runtimeBuildId: String,
    val promptVersions: Set<String>,
    val licenseNoticeIds: Set<String>,
    val nowMs: Long,
    val highestSequence: Long,
    val highestSequencePayloadSha256: String?,
    val knownBad: Set<String>,
    val profile: CompatibilityProfile,
)

sealed class VerifyResult {
    class Accepted(val descriptor: Descriptor, val payloadSha256: String) : VerifyResult()

    /** [reason] is for diagnostics/tests only; it never contains payload text. */
    class Rejected(val code: String, val reason: String) : VerifyResult()
}

/**
 * Signed release descriptor verification (SIG-001…005), step for step the
 * same order as model-release/descriptor/verify.mjs so both agree on every
 * shared vector (T08, T29, T30). The payload is parsed only AFTER the
 * signature over its exact bytes has been verified (SIG-002).
 */
class DescriptorVerifier(private val ed25519: Ed25519Verifier) {

    fun verify(envelopeBytes: ByteArray, ctx: VerifyContext): VerifyResult {
        if (envelopeBytes.isEmpty() || envelopeBytes.size > MAX_ENVELOPE_BYTES) {
            return invalid("envelope size")
        }
        val envelope = try {
            StrictJson.parseUtf8(envelopeBytes)
        } catch (e: StrictJsonException) {
            return invalid("envelope parse")
        }
        if (envelope !is JsonValue.Obj) return invalid("envelope not an object")
        val keyId = envelope.string("key_id")
        val payload = envelope.string("payload_b64")?.let { decodeBase64(it) }
        val signature = envelope.string("signature_b64")?.let { decodeBase64(it) }
        if (keyId.isNullOrEmpty() || payload == null || signature == null) {
            return invalid("envelope fields")
        }
        if (payload.isEmpty() || payload.size > MAX_PAYLOAD_BYTES) return invalid("payload size")
        if (signature.size != 64) return invalid("signature size")
        val key = ctx.keys.firstOrNull { it.keyId == keyId } ?: return invalid("unknown key")
        val publicRaw = decodeBase64(key.publicKeyB64)
        if (publicRaw == null || publicRaw.size != 32) return invalid("bundled key")
        if (!ed25519.verify(publicRaw, payload, signature)) return invalid("signature")

        // Only verified bytes are parsed from here on (SIG-002).
        val p = try {
            StrictJson.parseUtf8(payload)
        } catch (e: StrictJsonException) {
            return invalid("payload parse")
        }
        if (p !is JsonValue.Obj) return invalid("payload not an object")

        val schema = p.integer("schema") ?: return missing("schema")
        val sequence = p.integer("sequence") ?: return missing("sequence")
        val modelId = p.string("model_id") ?: return missing("model_id")
        val artifactVersion = p.string("artifact_version") ?: return missing("artifact_version")
        val path = p.string("path") ?: return missing("path")
        val bytes = p.integer("bytes") ?: return missing("bytes")
        val sha256 = p.string("sha256") ?: return missing("sha256")
        val upstreamRepo = p.string("upstream_repo") ?: return missing("upstream_repo")
        val upstreamRevision = p.string("upstream_revision") ?: return missing("upstream_revision")
        val upstreamFilename = p.string("upstream_filename") ?: return missing("upstream_filename")
        val architecture = p.string("architecture") ?: return missing("architecture")
        val quantization = p.string("quantization") ?: return missing("quantization")
        val runtimeBuildIds = p.stringArray("runtime_build_ids") ?: return missing("runtime_build_ids")
        val minAppBuild = p.integer("min_app_build") ?: return missing("min_app_build")
        val maxAppBuild = p.integer("max_app_build") ?: return missing("max_app_build")
        val promptVersion = p.string("prompt_version") ?: return missing("prompt_version")
        val licenseNoticeId = p.string("license_notice_id") ?: return missing("license_notice_id")
        val issuedAt = p.string("issued_at") ?: return missing("issued_at")
        val expiresAt = p.string("expires_at") ?: return missing("expires_at")

        if (schema != 1L) return invalid("unknown schema")
        if (sequence < 1) return invalid("sequence")
        if (modelId != MODEL_ID) return invalid("model_id")
        if (!ARTIFACT_VERSION.matches(artifactVersion)) return invalid("artifact_version")
        if (!isValidPath(path)) return invalid("path")
        if (bytes < 1 || bytes > MAX_ARTIFACT_BYTES) return invalid("bytes")
        if (!SHA256_HEX.matches(sha256)) return invalid("sha256")
        if (upstreamRepo.isEmpty() || upstreamFilename.isEmpty() || !REVISION.matches(upstreamRevision)) {
            return invalid("upstream fields")
        }
        val issued = parseTimestamp(issuedAt)
        val expires = parseTimestamp(expiresAt)
        if (issued == null || expires == null || expires <= issued) return invalid("timestamps")

        val payloadSha256 = Hex.encode(MessageDigest.getInstance("SHA-256").digest(payload))

        if (ctx.source == DescriptorSource.UPDATE) {
            if (expires - issued > MAX_VALIDITY_MS) return invalid("validity too long")
            if (issued > ctx.nowMs + CLOCK_SKEW_MS || ctx.nowMs >= expires) {
                return invalid("expired or not yet valid")
            }
            if (sequence < ctx.highestSequence) return invalid("sequence replay")
            val pinned = ctx.highestSequencePayloadSha256
            if (sequence == ctx.highestSequence && !pinned.isNullOrEmpty() && pinned != payloadSha256) {
                return invalid("same sequence, different payload")
            }
        }

        if (architecture !in ctx.profile.architectures || quantization !in ctx.profile.quantizations) {
            return incompatible("architecture/quantization")
        }
        if (ctx.runtimeBuildId !in runtimeBuildIds) return incompatible("runtime build")
        if (minAppBuild > maxAppBuild || ctx.appBuild < minAppBuild || ctx.appBuild > maxAppBuild) {
            return incompatible("app build range")
        }
        if (promptVersion !in ctx.promptVersions) return incompatible("prompt version")
        if (licenseNoticeId !in ctx.licenseNoticeIds) return incompatible("license notice")
        if (sha256 in ctx.knownBad) return VerifyResult.Rejected(ErrorCodes.FILE_DAMAGED, "known-bad artifact")

        return VerifyResult.Accepted(
            Descriptor(
                schema, sequence, modelId, artifactVersion, path, bytes, sha256,
                upstreamRepo, upstreamRevision, upstreamFilename, architecture, quantization,
                runtimeBuildIds, minAppBuild, maxAppBuild, promptVersion, licenseNoticeId,
                issued, expires,
            ),
            payloadSha256,
        )
    }

    private fun invalid(reason: String) = VerifyResult.Rejected(ErrorCodes.SIGNATURE_INVALID, reason)
    private fun missing(field: String) = invalid("missing or mistyped $field")
    private fun incompatible(reason: String) = VerifyResult.Rejected(ErrorCodes.MODEL_INCOMPATIBLE, reason)

    companion object {
        const val MAX_ENVELOPE_BYTES = 65_536
        const val MAX_PAYLOAD_BYTES = 32_768
        const val MAX_ARTIFACT_BYTES = 8_000_000_000L
        const val MAX_VALIDITY_MS = 180L * 24 * 3600 * 1000
        const val CLOCK_SKEW_MS = 24L * 3600 * 1000
        const val MODEL_ID = "namu-aya-global"

        private val B64 = Regex("[A-Za-z0-9+/]*={0,2}")
        private val ARTIFACT_VERSION = Regex("[A-Za-z0-9._-]{1,64}")
        private val PATH = Regex("[A-Za-z0-9._/-]{1,512}")
        val SHA256_HEX = Regex("[0-9a-f]{64}")
        private val REVISION = Regex("[0-9a-f]{40}")
        private val TIMESTAMP = Regex("([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z")

        /** Standard base64 with padding; null on any deviation. */
        fun decodeBase64(value: String): ByteArray? {
            if (value.length % 4 != 0 || !B64.matches(value)) return null
            return try {
                Base64.getDecoder().decode(value)
            } catch (e: IllegalArgumentException) {
                null
            }
        }

        fun isValidPath(path: String): Boolean {
            if (!PATH.matches(path)) return false
            if (path.startsWith("/") || path.contains("//")) return false
            return path.split("/").all { it.isNotEmpty() && it != "." && it != ".." }
        }

        /** RFC 3339 UTC, exactly `YYYY-MM-DDTHH:MM:SSZ`; null when malformed. */
        fun parseTimestamp(value: String): Long? {
            val m = TIMESTAMP.matchEntire(value) ?: return null
            val g = m.groupValues
            return try {
                LocalDateTime.of(
                    g[1].toInt(), g[2].toInt(), g[3].toInt(),
                    g[4].toInt(), g[5].toInt(), g[6].toInt(),
                ).toEpochSecond(ZoneOffset.UTC) * 1000
            } catch (e: DateTimeException) {
                null
            }
        }

        /**
         * Reads fields from an envelope that THIS app already verified and stored
         * in its own journal. Never call this on bytes from the network.
         */
        fun payloadOfStoredEnvelope(envelopeBytes: ByteArray): JsonValue.Obj? {
            return try {
                val env = StrictJson.parseUtf8(envelopeBytes) as? JsonValue.Obj ?: return null
                val payload = env.string("payload_b64")?.let { decodeBase64(it) } ?: return null
                StrictJson.parseUtf8(payload) as? JsonValue.Obj
            } catch (e: StrictJsonException) {
                null
            }
        }
    }
}
