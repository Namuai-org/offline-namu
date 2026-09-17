package org.namuai.offline.core.descriptor

import org.namuai.offline.core.ErrorCodes
import org.namuai.offline.core.testing.Fixtures
import org.namuai.offline.core.testing.TestSigner
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class DescriptorVerifierTest {
    private val signer = TestSigner()
    private val sha = "a".repeat(64)
    private val now = DescriptorVerifier.parseTimestamp("2026-09-17T12:00:00Z")!!

    private class CountingVerifier : Ed25519Verifier {
        var calls = 0
        private val real = TinkEd25519Verifier()
        override fun verify(publicKey32: ByteArray, message: ByteArray, signature64: ByteArray): Boolean {
            calls++
            return real.verify(publicKey32, message, signature64)
        }
    }

    private fun ctx(
        source: DescriptorSource = DescriptorSource.UPDATE,
        highest: Long = 0,
        pinned: String? = null,
        profile: CompatibilityProfile = CompatibilityProfile.PRODUCTION,
        keys: List<ReleaseKey> = TrustBundle.parseKeys(signer.keysJson()),
    ) = VerifyContext(
        keys, source, 100, Fixtures.RUNTIME, setOf("namu-text-2"), setOf("tiny-aya-cc-by-nc-4.0-v1"),
        now, highest, pinned, emptySet(), profile,
    )

    private fun verify(payload: ByteArray, c: VerifyContext = ctx()) =
        DescriptorVerifier(TinkEd25519Verifier()).verify(signer.envelope(payload), c)

    private fun codeOf(r: VerifyResult) = (r as VerifyResult.Rejected).code

    @Test
    fun acceptsAValidUpdate() {
        val ok = assertIs<VerifyResult.Accepted>(verify(Fixtures.payload(sha, 2_143_977_056, sequence = 6)))
        assertEquals(2_143_977_056, ok.descriptor.bytes)
        assertEquals(64, ok.payloadSha256.length)
    }

    @Test
    fun sequenceRules_T29() {
        val payload = Fixtures.payload(sha, 10, sequence = 5)
        val accepted = assertIs<VerifyResult.Accepted>(verify(payload, ctx(highest = 5)))
        // Same sequence, same payload hash: accept. Different hash: reject. Lower sequence: reject.
        assertIs<VerifyResult.Accepted>(verify(payload, ctx(highest = 5, pinned = accepted.payloadSha256)))
        val altered = Fixtures.payload(sha, 11, sequence = 5)
        assertEquals(ErrorCodes.SIGNATURE_INVALID, codeOf(verify(altered, ctx(highest = 5, pinned = accepted.payloadSha256))))
        assertEquals(ErrorCodes.SIGNATURE_INVALID, codeOf(verify(payload, ctx(highest = 6))))
        // The bundled descriptor neither consults nor advances the stored sequence.
        assertIs<VerifyResult.Accepted>(verify(payload, ctx(source = DescriptorSource.BUNDLED, highest = 99)))
    }

    @Test
    fun expiryRules_T29() {
        val expired = Fixtures.payload(sha, 10, issuedAt = "2026-01-01T00:00:00Z", expiresAt = "2026-06-01T00:00:00Z")
        assertEquals(ErrorCodes.SIGNATURE_INVALID, codeOf(verify(expired)))
        // SIG-004: the bundled descriptor stays trusted for its exact digest.
        assertIs<VerifyResult.Accepted>(verify(expired, ctx(source = DescriptorSource.BUNDLED)))
        val future = Fixtures.payload(sha, 10, issuedAt = "2026-09-19T12:00:01Z", expiresAt = "2026-12-01T00:00:00Z")
        assertEquals(ErrorCodes.SIGNATURE_INVALID, codeOf(verify(future)))
        val tooLong = Fixtures.payload(sha, 10, issuedAt = "2026-09-01T00:00:00Z", expiresAt = "2027-03-01T00:00:01Z")
        assertEquals(ErrorCodes.SIGNATURE_INVALID, codeOf(verify(tooLong)))
    }

    @Test
    fun keyRotationOnlyThroughBundledKeys_T30() {
        val other = TestSigner(keyId = "new-release-key")
        val payload = Fixtures.payload(sha, 10)
        val verifier = DescriptorVerifier(TinkEd25519Verifier())
        // A descriptor signed by a key this build does not bundle is rejected …
        assertIs<VerifyResult.Rejected>(verifier.verify(other.envelope(payload), ctx()))
        // … and accepted once an app upgrade bundles the new key next to the old one.
        val both = TrustBundle.parseKeys(signer.keysJson()) + TrustBundle.parseKeys(other.keysJson())
        assertIs<VerifyResult.Accepted>(verifier.verify(other.envelope(payload), ctx(keys = both)))
        assertIs<VerifyResult.Accepted>(verifier.verify(signer.envelope(payload), ctx(keys = both)))
        // Same key_id but another key's signature fails.
        assertIs<VerifyResult.Rejected>(
            verifier.verify(other.envelope(payload, keyIdOverride = signer.keyId), ctx(keys = both)),
        )
    }

    @Test
    fun payloadIsNeverParsedBeforeTheSignatureVerifies() {
        val counting = CountingVerifier()
        val verifier = DescriptorVerifier(counting)
        // Correctly signed garbage: the signature check runs first, then parsing fails.
        val r1 = verifier.verify(signer.envelope("not json".toByteArray()), ctx())
        assertEquals(1, counting.calls)
        assertEquals("payload parse", (r1 as VerifyResult.Rejected).reason)
        // Unknown key: rejected before any signature work or payload parsing.
        val r2 = verifier.verify(signer.envelope("{}".toByteArray(), keyIdOverride = "nobody"), ctx())
        assertEquals(1, counting.calls)
        assertEquals("unknown key", (r2 as VerifyResult.Rejected).reason)
    }

    @Test
    fun internalProfileAcceptsFixturesReleaseDoesNot() {
        val llama = Fixtures.payload(sha, 10, architecture = "llama")
        assertEquals(ErrorCodes.MODEL_INCOMPATIBLE, codeOf(verify(llama)))
        assertIs<VerifyResult.Accepted>(verify(llama, ctx(profile = CompatibilityProfile.INTERNAL)))
    }

    @Test
    fun helpers() {
        assertNull(DescriptorVerifier.decodeBase64("AAA"))
        assertNull(DescriptorVerifier.decodeBase64("AA=A"))
        assertNull(DescriptorVerifier.decodeBase64("A==="))
        assertNotNull(DescriptorVerifier.decodeBase64("AAA="))
        assertNull(DescriptorVerifier.parseTimestamp("2026-02-30T00:00:00Z"))
        assertNull(DescriptorVerifier.parseTimestamp("2026-09-17T12:00:00+00:00"))
        assertNull(DescriptorVerifier.parseTimestamp("2026-09-17T12:00:00.000Z"))
        assertEquals(1_789_646_400_000L, DescriptorVerifier.parseTimestamp("2026-09-17T12:00:00Z"))
        for (bad in listOf("/abs", "a//b", "../x", "a/../b", "a/./b", "a?b=1", "https://evil/x", "a b", "")) {
            assertEquals(false, DescriptorVerifier.isValidPath(bad), bad)
        }
        assertEquals(true, DescriptorVerifier.isValidPath("models/aya-global-q4km/abc/model.gguf"))
        assertEquals(emptyList(), TrustBundle.parseKeys("{\"keys\":1}".toByteArray()))
        val good = "b".repeat(64)
        assertEquals(setOf(good), TrustBundle.parseKnownBad("{\"sha256\":[\"$good\",\"XYZ\"]}".toByteArray()))
    }
}
