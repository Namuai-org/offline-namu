package org.namuai.offline.core.testing

import com.google.crypto.tink.subtle.Ed25519Sign
import org.namuai.offline.core.json.JsonOut
import org.namuai.offline.core.util.Hex
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.Base64
import java.util.Random

/** Throwaway Ed25519 test key; never trusted by any build. */
class TestSigner(val keyId: String = "test-key") {
    private val pair = Ed25519Sign.KeyPair.newKeyPair()
    private val signer = Ed25519Sign(pair.privateKey)

    fun keysJson(): ByteArray = JsonOut.stringify(
        mapOf("keys" to listOf(mapOf("key_id" to keyId, "public_key_b64" to b64(pair.publicKey)))),
    ).toByteArray()

    fun envelope(payload: ByteArray, keyIdOverride: String? = null): ByteArray = JsonOut.stringify(
        linkedMapOf(
            "key_id" to (keyIdOverride ?: keyId),
            "payload_b64" to b64(payload),
            "signature_b64" to b64(signer.sign(payload)),
        ),
    ).toByteArray()

    private fun b64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)
}

object Fixtures {
    const val RUNTIME = "llamarn-0.12.9-b10256"

    fun sha256(bytes: ByteArray): String = Hex.encode(MessageDigest.getInstance("SHA-256").digest(bytes))

    fun payload(
        sha256: String,
        bytes: Long,
        sequence: Long = 1,
        version: String = "aya-global-q4km-1",
        architecture: String = "cohere2",
        issuedAt: String = "2026-09-01T00:00:00Z",
        expiresAt: String = "2027-02-01T00:00:00Z",
        path: String = "models/aya-global-q4km/$sha256/model.gguf",
    ): ByteArray = JsonOut.stringify(
        linkedMapOf(
            "schema" to 1L,
            "sequence" to sequence,
            "model_id" to "namu-aya-global",
            "artifact_version" to version,
            "path" to path,
            "bytes" to bytes,
            "sha256" to sha256,
            "upstream_repo" to "CohereLabs/tiny-aya-global-GGUF",
            "upstream_revision" to "0123456789abcdef0123456789abcdef01234567",
            "upstream_filename" to "tiny-aya-global-q4_k_m.gguf",
            "architecture" to architecture,
            "quantization" to "Q4_K_M",
            "runtime_build_ids" to listOf(RUNTIME),
            "min_app_build" to 1L,
            "max_app_build" to 999999L,
            "prompt_version" to "namu-text-1",
            "license_notice_id" to "tiny-aya-cc-by-nc-4.0-v1",
            "issued_at" to issuedAt,
            "expires_at" to expiresAt,
        ),
    ).toByteArray()

    /** A structurally valid GGUF v3 header followed by deterministic filler up to [totalBytes]. */
    fun ggufModel(totalBytes: Int, architecture: String = "cohere2", seed: Long = 7): ByteArray {
        val header = GgufBuilder().kvString("general.name", "fixture")
            .kvU32("general.file_type", 15)
            .kvStringArray("tokenizer.ggml.tokens", listOf("<s>", "</s>", "a", "b"))
            .kvString("general.architecture", architecture)
            .build()
        require(totalBytes >= header.size)
        val out = ByteArray(totalBytes)
        Random(seed).nextBytes(out)
        System.arraycopy(header, 0, out, 0, header.size)
        return out
    }
}

/** Synthesizes GGUF headers for the bounded reader tests. */
class GgufBuilder(private val version: Int = 3, private val magic: String = "GGUF") {
    private val kvs = ArrayList<ByteArray>()
    var tensorCountOverride: Long? = null
    var kvCountOverride: Long? = null

    private fun le(size: Int, fill: (ByteBuffer) -> Unit): ByteArray =
        ByteBuffer.allocate(size).order(ByteOrder.LITTLE_ENDIAN).also(fill).array()

    fun u32(v: Long) = le(4) { it.putInt(v.toInt()) }
    fun u64(v: Long) = le(8) { it.putLong(v) }
    fun str(s: String): ByteArray = u64(s.toByteArray().size.toLong()) + s.toByteArray()

    fun kvRaw(key: String, type: Long, value: ByteArray) = apply { kvs.add(str(key) + u32(type) + value) }
    fun kvString(key: String, value: String) = kvRaw(key, 8, str(value))
    fun kvU32(key: String, value: Long) = kvRaw(key, 4, u32(value))
    fun kvStringArray(key: String, values: List<String>) = kvRaw(
        key, 9,
        u32(8) + u64(values.size.toLong()) + values.fold(ByteArray(0)) { acc, s -> acc + str(s) },
    )
    fun kvU8Array(key: String, count: Int) = kvRaw(key, 9, u32(0) + u64(count.toLong()) + ByteArray(count))

    fun build(): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(magic.toByteArray(Charsets.ISO_8859_1))
        out.write(u32(version.toLong()))
        out.write(u64(tensorCountOverride ?: 0L))
        out.write(u64(kvCountOverride ?: kvs.size.toLong()))
        kvs.forEach { out.write(it) }
        return out.toByteArray()
    }
}
