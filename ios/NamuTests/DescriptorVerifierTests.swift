import CryptoKit
import XCTest
@testable import Namu

/// Runs every shared conformance vector (T08, T29, T30). The JSON is bundled
/// by reference from model-release/test-vectors/descriptor-vectors.json.
final class DescriptorVerifierTests: XCTestCase {
  private struct Vectors {
    let keys: [VerificationKey]
    let context: [String: Any]
    let vectors: [[String: Any]]
  }

  private func loadVectors() throws -> Vectors {
    let url = try XCTUnwrap(Bundle(for: DescriptorVerifierTests.self)
      .url(forResource: "descriptor-vectors", withExtension: "json"))
    let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    let keys = try XCTUnwrap(root["keys"] as? [[String: String]]).map {
      VerificationKey(keyId: $0["key_id"] ?? "", publicKeyB64: $0["public_key_b64"] ?? "")
    }
    return Vectors(
      keys: keys, context: try XCTUnwrap(root["context"] as? [String: Any]),
      vectors: try XCTUnwrap(root["vectors"] as? [[String: Any]]))
  }

  private func makeContext(_ base: [String: Any], overrides: [String: Any], keys: [VerificationKey], source: DescriptorSource) throws -> DescriptorContext {
    let merged = base.merging(overrides) { _, new in new }
    let now = try XCTUnwrap(DescriptorVerifier.parseTimestamp(try XCTUnwrap(merged["now"] as? String)))
    return DescriptorContext(
      keys: keys, source: source, appBuild: (merged["appBuild"] as? NSNumber)?.int64Value ?? 0,
      runtimeBuildId: merged["runtimeBuildId"] as? String ?? "",
      promptVersions: merged["promptVersions"] as? [String] ?? [],
      licenseNoticeIds: merged["licenseNoticeIds"] as? [String] ?? [], nowMs: now,
      highestSequence: (merged["highestSequence"] as? NSNumber)?.int64Value ?? 0,
      highestSequencePayloadSha256: merged["highestSequencePayloadSha256"] as? String,
      knownBad: Set(merged["knownBad"] as? [String] ?? []), profile: .production)
  }

  func testAllSharedVectors() throws {
    let file = try loadVectors()
    XCTAssertGreaterThanOrEqual(file.vectors.count, 40, "vector file looks truncated")
    var accepted = 0
    for vector in file.vectors {
      let name = try XCTUnwrap(vector["name"] as? String)
      let source = try XCTUnwrap(DescriptorSource(rawValue: try XCTUnwrap(vector["source"] as? String)))
      let envelope = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(vector["envelope_b64"] as? String)))
      let expect = try XCTUnwrap(vector["expect"] as? String)
      let context = try makeContext(
        file.context, overrides: vector["context"] as? [String: Any] ?? [:], keys: file.keys, source: source)
      let actual: String
      switch DescriptorVerifier.verify(envelope: envelope, context: context) {
      case .accepted: actual = "accept"; accepted += 1
      case .rejected(let code, _): actual = code
      }
      XCTAssertEqual(actual, expect, "vector \(name)")
    }
    XCTAssertGreaterThan(accepted, 0)
  }

  // MARK: - Locally signed descriptors (independent of the shared key)

  private func payload(_ overrides: [String: Any] = [:]) -> [String: Any] {
    var p: [String: Any] = [
      "schema": 1, "sequence": 3, "model_id": "namu-aya-global", "artifact_version": "fixture-1",
      "path": "models/aya-global-q4km/\(TestSupport.sha("a"))/model.gguf", "bytes": 1024,
      "sha256": TestSupport.sha("a"), "upstream_repo": "dev/fixture",
      "upstream_revision": String(repeating: "0", count: 40), "upstream_filename": "fixture.gguf",
      "architecture": "llama", "quantization": "F16", "runtime_build_ids": ["llamarn-0.12.9-b10256"],
      "min_app_build": 1, "max_app_build": 10, "prompt_version": "namu-text-2",
      "license_notice_id": "tiny-aya-cc-by-nc-4.0-v1", "issued_at": "2026-09-01T00:00:00Z",
      "expires_at": "2026-12-01T00:00:00Z",
    ]
    overrides.forEach { p[$0.key] = $0.value }
    return p
  }

  private func sign(_ payload: [String: Any], key: Curve25519.Signing.PrivateKey, keyId: String = "k1") throws -> Data {
    let bytes = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    let envelope: [String: Any] = [
      "key_id": keyId, "payload_b64": bytes.base64EncodedString(),
      "signature_b64": try key.signature(for: bytes).base64EncodedString(),
    ]
    return try JSONSerialization.data(withJSONObject: envelope)
  }

  private func context(_ key: Curve25519.Signing.PrivateKey, profile: DescriptorProfile) -> DescriptorContext {
    DescriptorContext(
      keys: [VerificationKey(keyId: "k1", publicKeyB64: key.publicKey.rawRepresentation.base64EncodedString())],
      source: .update, appBuild: 5, runtimeBuildId: "llamarn-0.12.9-b10256",
      nowMs: DescriptorVerifier.parseTimestamp("2026-09-17T12:00:00Z")!, profile: profile)
  }

  func testInternalFixtureProfileIsNeverAcceptedByProduction() throws {
    let key = Curve25519.Signing.PrivateKey()
    let envelope = try sign(payload(), key: key)
    guard case .accepted(let descriptor, _) = DescriptorVerifier.verify(envelope: envelope, context: context(key, profile: .internalFixture)) else {
      return XCTFail("internal profile should accept the fixture")
    }
    XCTAssertEqual(descriptor.architecture, "llama")
    XCTAssertEqual(
      DescriptorVerifier.verify(envelope: envelope, context: context(key, profile: .production)),
      .rejected(code: "MODEL_INCOMPATIBLE", reason: "architecture/quantization"))
  }

  func testSignatureIsCheckedBeforePayloadIsParsed() throws {
    let key = Curve25519.Signing.PrivateKey()
    let other = Curve25519.Signing.PrivateKey()
    // A payload that is not even JSON, signed by the wrong key: the rejection
    // reason must be the signature, proving the parser never saw it.
    let bytes = Data("not json".utf8)
    let envelope = try JSONSerialization.data(withJSONObject: [
      "key_id": "k1", "payload_b64": bytes.base64EncodedString(),
      "signature_b64": try other.signature(for: bytes).base64EncodedString(),
    ])
    XCTAssertEqual(
      DescriptorVerifier.verify(envelope: envelope, context: context(key, profile: .production)),
      .rejected(code: "SIGNATURE_INVALID", reason: "signature"))
  }

  func testTimestampParser() {
    XCTAssertEqual(DescriptorVerifier.parseTimestamp("1970-01-01T00:00:00Z"), 0)
    XCTAssertEqual(DescriptorVerifier.parseTimestamp("2026-09-17T12:00:00Z"), 1_789_646_400_000)
    XCTAssertEqual(DescriptorVerifier.parseTimestamp("2024-02-29T23:59:59Z"), 1_709_251_199_000)
    for bad in ["2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-09-17T12:00:00+01:00", "2026-09-17 12:00:00Z",
                "2026-09-17T12:00:00.000Z", "2026-09-17T25:00:00Z", "2026-09-17T12:60:00Z", "2025-02-29T00:00:00Z"] {
      XCTAssertNil(DescriptorVerifier.parseTimestamp(bad), bad)
    }
    XCTAssertEqual(DescriptorVerifier.formatTimestamp(ms: 1_789_646_400_000), "2026-09-17T12:00:00Z")
  }

  func testBase64IsStrict() {
    XCTAssertEqual(DescriptorVerifier.decodeBase64("QUJD"), Data("ABC".utf8))
    XCTAssertEqual(DescriptorVerifier.decodeBase64("QUI="), Data("AB".utf8))
    for bad in ["QUJ", "QU=J", "QUJD\n", "QUJ-", "Q===", " QUJD"] {
      XCTAssertNil(DescriptorVerifier.decodeBase64(bad), bad)
    }
  }

  func testOriginPolicy() {
    XCTAssertEqual(NamuBuildConfig.validatedOrigin("https://d111.cloudfront.net", isInternalBuild: false), "https://d111.cloudfront.net")
    XCTAssertNil(NamuBuildConfig.validatedOrigin("http://d111.cloudfront.net", isInternalBuild: false))
    XCTAssertNil(NamuBuildConfig.validatedOrigin("http://localhost:8787", isInternalBuild: false))
    XCTAssertEqual(NamuBuildConfig.validatedOrigin("http://localhost:8787", isInternalBuild: true), "http://localhost:8787")
    XCTAssertNil(NamuBuildConfig.validatedOrigin("http://example.com", isInternalBuild: true))
    XCTAssertNil(NamuBuildConfig.validatedOrigin("https://host/path", isInternalBuild: true))
    XCTAssertNil(NamuBuildConfig.validatedOrigin("https://user@host", isInternalBuild: true))
    XCTAssertNil(NamuBuildConfig.validatedOrigin("", isInternalBuild: true))
    XCTAssertTrue(NamuBuildConfig.isSameOrigin(URL(string: "https://host:443/a/b"), origin: "https://host"))
    XCTAssertFalse(NamuBuildConfig.isSameOrigin(URL(string: "https://evil.example/a"), origin: "https://host"))
    XCTAssertFalse(NamuBuildConfig.isSameOrigin(URL(string: "http://host/a"), origin: "https://host"))
  }
}
