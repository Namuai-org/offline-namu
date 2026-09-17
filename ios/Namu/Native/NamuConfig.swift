import Foundation

/// Build configuration (contract §1). None of this is secret: a public
/// verification key and an origin host name.
struct NamuBuildConfig {
  let bundleId: String
  /// `.internal` builds may use the development origin and fixture profile.
  let isInternalBuild: Bool
  let appVersion: String
  let appBuild: Int64
  let runtimeBuildId: String
  /// `scheme://host[:port]`, nil when the configured origin is not allowed.
  let modelOrigin: String?
  let keys: [VerificationKey]
  let bundledKnownBad: Set<String>
  let bundledDescriptor: Data?

  var profile: DescriptorProfile { isInternalBuild ? .internalFixture : .production }

  /// The main bundle's configuration, read once.
  static let current = NamuBuildConfig.load()

  static func load(bundle: Bundle = .main) -> NamuBuildConfig {
    let info = bundle.infoDictionary ?? [:]
    let bundleId = bundle.bundleIdentifier ?? ""
    let isInternal = bundleId.hasSuffix(".internal")
    let build = Int64(info["CFBundleVersion"] as? String ?? "") ?? 0
    return NamuBuildConfig(
      bundleId: bundleId,
      isInternalBuild: isInternal,
      appVersion: info["CFBundleShortVersionString"] as? String ?? "",
      appBuild: build,
      runtimeBuildId: info["NamuRuntimeBuildId"] as? String ?? "",
      modelOrigin: validatedOrigin(info["NamuModelOrigin"] as? String, isInternalBuild: isInternal),
      keys: loadKeys(bundle: bundle, isInternalBuild: isInternal),
      bundledKnownBad: loadKnownBad(bundle: bundle),
      bundledDescriptor: resource("initial-descriptor", bundle: bundle, maxBytes: DescriptorVerifier.maxEnvelopeBytes))
  }

  /// Release builds refuse a non-HTTPS origin; internal builds may also use
  /// cleartext to the local fault server only.
  static func validatedOrigin(_ raw: String?, isInternalBuild: Bool) -> String? {
    guard let raw, let components = URLComponents(string: raw), let scheme = components.scheme?.lowercased(),
          let host = components.host?.lowercased(), !host.isEmpty,
          components.path.isEmpty, components.query == nil, components.fragment == nil,
          components.user == nil, components.password == nil else { return nil }
    let localHosts: Set<String> = ["localhost", "127.0.0.1"]
    guard scheme == "https" || (scheme == "http" && isInternalBuild && localHosts.contains(host)) else {
      return nil
    }
    return components.port.map { "\(scheme)://\(host):\($0)" } ?? "\(scheme)://\(host)"
  }

  /// Same-origin test used for redirects and final response URLs (DL-003).
  static func isSameOrigin(_ url: URL?, origin: String) -> Bool {
    guard let url, let a = URLComponents(url: url, resolvingAgainstBaseURL: false),
          let b = URLComponents(string: origin) else { return false }
    func port(_ c: URLComponents) -> Int { c.port ?? (c.scheme?.lowercased() == "https" ? 443 : 80) }
    return a.scheme?.lowercased() == b.scheme?.lowercased() && a.host?.lowercased() == b.host?.lowercased()
      && port(a) == port(b)
  }

  private static func resource(_ name: String, bundle: Bundle, maxBytes: Int) -> Data? {
    guard let url = bundle.url(forResource: name, withExtension: "json"),
          let data = try? Data(contentsOf: url), !data.isEmpty, data.count <= maxBytes else { return nil }
    return data
  }

  private static func loadKeys(bundle: Bundle, isInternalBuild: Bool) -> [VerificationKey] {
    guard let data = resource("release-keys", bundle: bundle, maxBytes: 64 * 1024),
          let root = try? StrictJSON.parse(data), case .object(let map) = root,
          case .array(let items)? = map["keys"] else { return [] }
    return items.compactMap { item in
      guard let keyId = item.string("key_id"), let key = item.string("public_key_b64") else { return nil }
      // Defence in depth behind the Release build guard: a development key is
      // never trusted outside internal builds (contract §4).
      if keyId.hasPrefix("dev-") && !isInternalBuild { return nil }
      return VerificationKey(keyId: keyId, publicKeyB64: key)
    }
  }

  private static func loadKnownBad(bundle: Bundle) -> Set<String> {
    guard let data = resource("known-bad", bundle: bundle, maxBytes: 1024 * 1024),
          let root = try? StrictJSON.parse(data), let list = root.stringArray("sha256") else { return [] }
    return Set(list.filter(NamuPattern.isSha256Hex))
  }
}
