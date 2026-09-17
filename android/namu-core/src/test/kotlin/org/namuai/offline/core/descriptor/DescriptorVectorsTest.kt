package org.namuai.offline.core.descriptor

import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import org.namuai.offline.core.json.JsonValue
import org.namuai.offline.core.json.StrictJson
import org.namuai.offline.core.json.obj
import org.namuai.offline.core.json.string
import java.io.File
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * T08 / T29 / T30: every shared conformance vector of
 * model-release/test-vectors/descriptor-vectors.json (read in place, never
 * copied) must give the same verdict as the Node reference verifier.
 */
class DescriptorVectorsTest {
    private val file = File(System.getProperty("namu.descriptorVectors"))
    private val root = StrictJson.parseUtf8(file.readBytes()) as JsonValue.Obj
    private val verifier = DescriptorVerifier(TinkEd25519Verifier())

    private val keys = (root.members["keys"] as JsonValue.Arr).items.map {
        val o = it as JsonValue.Obj
        ReleaseKey(o.string("key_id")!!, o.string("public_key_b64")!!)
    }

    private fun context(source: String, overrides: JsonValue.Obj): VerifyContext {
        val base = root.obj("context")!!
        fun pick(key: String): JsonValue? = overrides.members[key] ?: base.members[key]
        fun strings(key: String) = (pick(key) as JsonValue.Arr).items.map { (it as JsonValue.Str).value }.toSet()
        return VerifyContext(
            keys = keys,
            source = DescriptorSource.fromWire(source)!!,
            appBuild = (pick("appBuild") as JsonValue.Num).longValue,
            runtimeBuildId = (pick("runtimeBuildId") as JsonValue.Str).value,
            promptVersions = strings("promptVersions"),
            licenseNoticeIds = strings("licenseNoticeIds"),
            nowMs = DescriptorVerifier.parseTimestamp((pick("now") as JsonValue.Str).value)!!,
            highestSequence = (pick("highestSequence") as JsonValue.Num).longValue,
            highestSequencePayloadSha256 = (pick("highestSequencePayloadSha256") as? JsonValue.Str)?.value,
            knownBad = strings("knownBad"),
            profile = CompatibilityProfile.PRODUCTION,
        )
    }

    private fun vectors() = (root.members["vectors"] as JsonValue.Arr).items.map { it as JsonValue.Obj }

    @TestFactory
    fun sharedVectors(): List<DynamicTest> = vectors().map { v ->
        val name = v.string("name")!!
        DynamicTest.dynamicTest(name) {
            val envelope = Base64.getDecoder().decode(v.string("envelope_b64")!!)
            val result = verifier.verify(envelope, context(v.string("source")!!, v.obj("context")!!))
            val verdict = when (result) {
                is VerifyResult.Accepted -> "accept"
                is VerifyResult.Rejected -> result.code
            }
            val detail = (result as? VerifyResult.Rejected)?.reason ?: ""
            assertEquals(v.string("expect"), verdict, "$name ($detail)")
        }
    }

    @Test
    fun vectorFileIsTheSharedOneAndComplete() {
        assertTrue(file.path.replace('\\', '/').endsWith("model-release/test-vectors/descriptor-vectors.json"))
        val all = vectors()
        assertTrue(all.size >= 41, "expected the full shared vector set, found ${all.size}")
        val verdicts = all.map { it.string("expect")!! }.toSet()
        assertTrue(verdicts.containsAll(setOf("accept", "SIGNATURE_INVALID", "MODEL_INCOMPATIBLE", "FILE_DAMAGED")))
    }
}
