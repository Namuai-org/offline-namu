package org.namuai.offline.core.descriptor

import org.namuai.offline.core.json.JsonValue
import org.namuai.offline.core.json.StrictJson
import org.namuai.offline.core.json.StrictJsonException
import org.namuai.offline.core.json.string
import org.namuai.offline.core.json.stringArray

/**
 * Build-time trust inputs (contract §1): bundled verification keys, the bundled
 * signed descriptor and the bundled known-bad list. The Android glue reads the
 * three asset files; parsing lives here so it is JVM-tested.
 */
interface TrustSource {
    /** Raw bytes of assets/namu/release-keys.json, or null when absent. */
    fun releaseKeysJson(): ByteArray?

    /** Raw bytes of assets/namu/initial-descriptor.json, or null when absent. */
    fun bundledDescriptor(): ByteArray?

    /** Raw bytes of assets/namu/known-bad.json, or null when absent. */
    fun knownBadJson(): ByteArray?
}

object TrustBundle {
    /** `{"keys":[{"key_id":"…","public_key_b64":"…"}]}`; malformed input yields no keys. */
    fun parseKeys(json: ByteArray?): List<ReleaseKey> {
        if (json == null) return emptyList()
        return try {
            val root = StrictJson.parseUtf8(json) as? JsonValue.Obj ?: return emptyList()
            val keys = root.members["keys"] as? JsonValue.Arr ?: return emptyList()
            keys.items.mapNotNull { item ->
                val o = item as? JsonValue.Obj ?: return@mapNotNull null
                val id = o.string("key_id") ?: return@mapNotNull null
                val pk = o.string("public_key_b64") ?: return@mapNotNull null
                ReleaseKey(id, pk)
            }
        } catch (e: StrictJsonException) {
            emptyList()
        }
    }

    /** `{"sha256":["<hex>", …]}`; malformed input yields an empty set. */
    fun parseKnownBad(json: ByteArray?): Set<String> {
        if (json == null) return emptySet()
        return try {
            val root = StrictJson.parseUtf8(json) as? JsonValue.Obj ?: return emptySet()
            (root.stringArray("sha256") ?: emptyList())
                .filter { DescriptorVerifier.SHA256_HEX.matches(it) }
                .toSet()
        } catch (e: StrictJsonException) {
            emptySet()
        }
    }
}
