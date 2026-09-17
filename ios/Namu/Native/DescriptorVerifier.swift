import CryptoKit
import Foundation

/// Verified, typed view of a signed release descriptor payload (SIG-002).
struct ReleaseDescriptor: Equatable {
  let schema: Int64
  let sequence: Int64
  let modelId: String
  let artifactVersion: String
  let path: String
  let bytes: Int64
  let sha256: String
  let upstreamRepo: String
  let upstreamRevision: String
  let upstreamFilename: String
  let architecture: String
  let quantization: String
  let runtimeBuildIds: [String]
  let minAppBuild: Int64
  let maxAppBuild: Int64
  let promptVersion: String
  let licenseNoticeId: String
  let issuedAtMs: Int64
  let expiresAtMs: Int64
}

struct VerificationKey: Equatable {
  let keyId: String
  let publicKeyB64: String
}

enum DescriptorSource: String {
  case bundled
  case update
}

struct DescriptorProfile: Equatable {
  let architectures: [String]
  let quantizations: [String]

  /// Release builds accept only the locked production artifact family.
  static let production = DescriptorProfile(architectures: ["cohere2"], quantizations: ["Q4_K_M"])
  /// Internal builds also accept the small development fixture (REL-001).
  static let internalFixture = DescriptorProfile(
    architectures: ["cohere2", "llama"], quantizations: ["Q4_K_M", "Q8_0", "F16", "F32"])
}

struct DescriptorContext {
  var keys: [VerificationKey]
  var source: DescriptorSource
  var appBuild: Int64
  var runtimeBuildId: String
  var promptVersions: [String] = NamuConstants.understoodPromptVersions
  var licenseNoticeIds: [String] = NamuConstants.bundledLicenseNoticeIds
  var nowMs: Int64
  var highestSequence: Int64 = 0
  var highestSequencePayloadSha256: String?
  var knownBad: Set<String> = []
  var profile: DescriptorProfile = .production
}

enum DescriptorVerification: Equatable {
  case accepted(ReleaseDescriptor, payloadSha256: String)
  case rejected(code: String, reason: String)
}

/// Mirrors model-release/descriptor/verify.mjs step by step (contract §4).
/// Both must agree on every vector in descriptor-vectors.json.
enum DescriptorVerifier {
  static let maxEnvelopeBytes = 65_536
  static let maxPayloadBytes = 32_768
  static let maxValidityMs: Int64 = 180 * 24 * 3600 * 1000
  static let clockSkewMs: Int64 = 24 * 3600 * 1000

  static func verify(envelope raw: Data, context ctx: DescriptorContext) -> DescriptorVerification {
    func reject(_ code: String, _ reason: String) -> DescriptorVerification {
      .rejected(code: code, reason: reason)
    }
    let invalid = NamuError.signatureInvalid

    // 1. Size limits and strict parse of the envelope.
    guard !raw.isEmpty, raw.count <= maxEnvelopeBytes else { return reject(invalid, "envelope size") }
    guard let envelope = try? StrictJSON.parse(raw), case .object = envelope else {
      return reject(invalid, "envelope parse")
    }
    guard let keyId = envelope.string("key_id"), !keyId.isEmpty,
          let payload = decodeBase64(envelope.string("payload_b64")),
          let signature = decodeBase64(envelope.string("signature_b64")) else {
      return reject(invalid, "envelope fields")
    }
    guard !payload.isEmpty, payload.count <= maxPayloadBytes else { return reject(invalid, "payload size") }
    guard signature.count == 64 else { return reject(invalid, "signature size") }

    // 2. key_id selects a bundled key.
    guard let key = ctx.keys.first(where: { $0.keyId == keyId }) else { return reject(invalid, "unknown key") }
    guard let publicRaw = decodeBase64(key.publicKeyB64), publicRaw.count == 32,
          let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: publicRaw) else {
      return reject(invalid, "bundled key")
    }

    // 3. Ed25519 over the exact decoded payload bytes (SIG-002).
    guard publicKey.isValidSignature(signature, for: payload) else { return reject(invalid, "signature") }

    // 4. Only verified bytes are parsed from here on.
    guard let p = try? StrictJSON.parse(payload), case .object = p else {
      return reject(invalid, "payload parse")
    }

    // 5. Field validation. Unknown fields are ignored (SIG-003).
    guard let schema = p.integer("schema"),
          let sequence = p.integer("sequence"),
          let modelId = p.string("model_id"),
          let artifactVersion = p.string("artifact_version"),
          let path = p.string("path"),
          let bytes = p.integer("bytes"),
          let sha256 = p.string("sha256"),
          let upstreamRepo = p.string("upstream_repo"),
          let upstreamRevision = p.string("upstream_revision"),
          let upstreamFilename = p.string("upstream_filename"),
          let architecture = p.string("architecture"),
          let quantization = p.string("quantization"),
          let runtimeBuildIds = p.stringArray("runtime_build_ids"),
          let minAppBuild = p.integer("min_app_build"),
          let maxAppBuild = p.integer("max_app_build"),
          let promptVersion = p.string("prompt_version"),
          let licenseNoticeId = p.string("license_notice_id"),
          let issuedAt = p.string("issued_at"),
          let expiresAt = p.string("expires_at") else {
      return reject(invalid, "missing or mistyped field")
    }
    guard schema == 1 else { return reject(invalid, "unknown schema") }
    guard sequence >= 1 else { return reject(invalid, "sequence") }
    guard modelId == NamuConstants.modelId else { return reject(invalid, "model_id") }
    guard isArtifactVersion(artifactVersion) else { return reject(invalid, "artifact_version") }
    guard isValidPath(path) else { return reject(invalid, "path") }
    guard bytes >= 1, bytes <= 8_000_000_000 else { return reject(invalid, "bytes") }
    guard NamuPattern.isSha256Hex(sha256) else { return reject(invalid, "sha256") }
    guard !upstreamRepo.isEmpty, !upstreamFilename.isEmpty,
          NamuPattern.isLowerHex(upstreamRevision, length: 40) else {
      return reject(invalid, "upstream fields")
    }
    guard let issued = parseTimestamp(issuedAt), let expires = parseTimestamp(expiresAt), expires > issued else {
      return reject(invalid, "timestamps")
    }

    let payloadSha256 = Data(SHA256.hash(data: payload)).namuHex

    // 6 + 7. Sequence and validity apply to remote metadata only (SIG-004).
    if ctx.source == .update {
      if expires - issued > maxValidityMs { return reject(invalid, "validity too long") }
      if issued > ctx.nowMs + clockSkewMs || ctx.nowMs >= expires {
        return reject(invalid, "expired or not yet valid")
      }
      if sequence < ctx.highestSequence { return reject(invalid, "sequence replay") }
      if sequence == ctx.highestSequence, let known = ctx.highestSequencePayloadSha256, !known.isEmpty,
         known != payloadSha256 {
        return reject(invalid, "same sequence, different payload")
      }
    }

    // Compatibility failures are MODEL_INCOMPATIBLE.
    let incompatible = NamuError.modelIncompatible
    guard ctx.profile.architectures.contains(architecture),
          ctx.profile.quantizations.contains(quantization) else {
      return reject(incompatible, "architecture/quantization")
    }
    guard runtimeBuildIds.contains(ctx.runtimeBuildId) else { return reject(incompatible, "runtime build") }
    guard minAppBuild <= maxAppBuild, ctx.appBuild >= minAppBuild, ctx.appBuild <= maxAppBuild else {
      return reject(incompatible, "app build range")
    }
    guard ctx.promptVersions.contains(promptVersion) else { return reject(incompatible, "prompt version") }
    guard ctx.licenseNoticeIds.contains(licenseNoticeId) else { return reject(incompatible, "license notice") }

    // 8. Known-bad artifacts are never offered again.
    if ctx.knownBad.contains(sha256) { return reject(NamuError.fileDamaged, "known-bad artifact") }

    let descriptor = ReleaseDescriptor(
      schema: schema, sequence: sequence, modelId: modelId, artifactVersion: artifactVersion,
      path: path, bytes: bytes, sha256: sha256, upstreamRepo: upstreamRepo,
      upstreamRevision: upstreamRevision, upstreamFilename: upstreamFilename,
      architecture: architecture, quantization: quantization, runtimeBuildIds: runtimeBuildIds,
      minAppBuild: minAppBuild, maxAppBuild: maxAppBuild, promptVersion: promptVersion,
      licenseNoticeId: licenseNoticeId, issuedAtMs: issued, expiresAtMs: expires)
    return .accepted(descriptor, payloadSha256: payloadSha256)
  }

  // MARK: - Field rules

  /// Standard base64 with padding: `^[A-Za-z0-9+/]*={0,2}$`, length % 4 == 0.
  static func decodeBase64(_ value: String?) -> Data? {
    guard let value else { return nil }
    let bytes = Array(value.utf8)
    guard bytes.count % 4 == 0 else { return nil }
    var padding = 0
    for (offset, byte) in bytes.enumerated() {
      if byte == UInt8(ascii: "=") {
        padding += 1
        guard offset >= bytes.count - 2 else { return nil }
      } else {
        guard padding == 0 else { return nil }
        let isAlphabet = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
          || (byte >= 0x30 && byte <= 0x39) || byte == 0x2b || byte == 0x2f
        guard isAlphabet else { return nil }
      }
    }
    return Data(base64Encoded: value)
  }

  private static func isPathCharacter(_ byte: UInt8) -> Bool {
    (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)
      || byte == 0x2e || byte == 0x5f || byte == 0x2f || byte == 0x2d
  }

  /// `^[A-Za-z0-9._-]{1,64}$`
  static func isArtifactVersion(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    return (1...64).contains(bytes.count) && bytes.allSatisfy { isPathCharacter($0) && $0 != 0x2f }
  }

  /// `^[A-Za-z0-9._/-]{1,512}$`, relative, no empty, `.` or `..` segment.
  static func isValidPath(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard (1...512).contains(bytes.count), bytes.allSatisfy(isPathCharacter) else { return false }
    guard bytes.first != 0x2f else { return false }
    let segments = value.split(separator: "/", omittingEmptySubsequences: false)
    return segments.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
  }

  /// RFC 3339 UTC, exactly `YYYY-MM-DDTHH:MM:SSZ`. Returns epoch milliseconds.
  static func parseTimestamp(_ value: String) -> Int64? {
    let b = Array(value.utf8)
    guard b.count == 20, b[4] == 0x2d, b[7] == 0x2d, b[10] == UInt8(ascii: "T"),
          b[13] == 0x3a, b[16] == 0x3a, b[19] == UInt8(ascii: "Z") else { return nil }
    func number(_ range: Range<Int>) -> Int64? {
      var out: Int64 = 0
      for i in range {
        guard b[i] >= 0x30, b[i] <= 0x39 else { return nil }
        out = out * 10 + Int64(b[i] - 0x30)
      }
      return out
    }
    guard let year = number(0..<4), let month = number(5..<7), let day = number(8..<10),
          let hour = number(11..<13), let minute = number(14..<16), let second = number(17..<19) else {
      return nil
    }
    guard (1...12).contains(month), minute <= 59, second <= 59 else { return nil }
    // ECMAScript accepts 24:00:00 as the end of the day; mirror the reference.
    guard hour <= 23 || (hour == 24 && minute == 0 && second == 0) else { return nil }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
    let daysInMonth: [Int64] = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    guard day >= 1, day <= daysInMonth[Int(month - 1)] else { return nil }
    // Days from civil (proleptic Gregorian), Howard Hinnant's algorithm.
    let y = month <= 2 ? year - 1 : year
    let era = (y >= 0 ? y : y - 399) / 400
    let yoe = y - era * 400
    let mp = (month + 9) % 12
    let doy = (153 * mp + 2) / 5 + day - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    let days = era * 146_097 + doe - 719_468
    return ((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000
  }

  static func formatTimestamp(ms: Int64) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    return formatter.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
  }
}
