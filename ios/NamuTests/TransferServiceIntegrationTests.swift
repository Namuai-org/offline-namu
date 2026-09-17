import CryptoKit
import XCTest
@testable import Namu

/// End-to-end transfer pipeline against an in-process HTTP server, with no JS
/// runtime anywhere (ARC-003): signed descriptor → background URLSession
/// download → length → SHA-256 → GGUF check → staged → self-test → activation.
/// Covers T07, T08 and the honest-restart rule on the iOS simulator.
final class TransferServiceIntegrationTests: XCTestCase {
  private var root: URL!
  private var server: LocalHTTPServer!
  private var service: TransferService!
  private let key = Curve25519.Signing.PrivateKey()

  override func setUpWithError() throws {
    root = try TestSupport.makeTemporaryDirectory("transfer")
    server = try LocalHTTPServer()
    try server.start()
  }

  override func tearDown() {
    if let service {
      let done = expectation(description: "shutdown")
      service.shutdown { done.fulfill() }
      wait(for: [done], timeout: 20)
    }
    service = nil
    server.stop()
    TestSupport.remove(root)
  }

  // MARK: - Fixtures

  /// Small structurally valid GGUF: header + general.architecture + padding.
  private func gguf(architecture: String = "llama", size: Int = 256 * 1024, seed: UInt8 = 1) -> Data {
    func u32(_ v: UInt32) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
    func u64(_ v: UInt64) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
    func str(_ s: String) -> Data { var d = u64(UInt64(s.utf8.count)); d.append(Data(s.utf8)); return d }
    var data = Data("GGUF".utf8)
    for part in [u32(3), u64(0), u64(1), str("general.architecture"), u32(8), str(architecture)] { data.append(part) }
    data.append(Data(repeating: seed, count: max(0, size - data.count)))
    return data
  }

  private func path(_ sha: String) -> String { "models/aya-global-q4km/\(sha)/model.gguf" }

  private func envelope(for artifact: Data, claimedSha: String? = nil, architecture: String = "llama",
                        signer: Curve25519.Signing.PrivateKey? = nil, sequence: Int = 1) throws -> Data {
    let sha = claimedSha ?? Data(SHA256.hash(data: artifact)).namuHex
    let payload: [String: Any] = [
      "schema": 1, "sequence": sequence, "model_id": "namu-aya-global", "artifact_version": "fixture-\(sequence)",
      "path": path(sha), "bytes": artifact.count, "sha256": sha, "upstream_repo": "dev/fixture",
      "upstream_revision": String(repeating: "0", count: 40), "upstream_filename": "fixture.gguf",
      "architecture": architecture, "quantization": "F16", "runtime_build_ids": ["llamarn-0.12.9-b10256"],
      "min_app_build": 1, "max_app_build": 999_999, "prompt_version": "namu-text-1",
      "license_notice_id": "tiny-aya-cc-by-nc-4.0-v1",
      "issued_at": DescriptorVerifier.formatTimestamp(ms: namuNowMs() - 3_600_000),
      "expires_at": DescriptorVerifier.formatTimestamp(ms: namuNowMs() + 30 * 24 * 3_600_000),
    ]
    let bytes = try JSONSerialization.data(withJSONObject: payload)
    return try JSONSerialization.data(withJSONObject: [
      "key_id": "dev-test", "payload_b64": bytes.base64EncodedString(),
      "signature_b64": try (signer ?? key).signature(for: bytes).base64EncodedString(),
    ])
  }

  private func makeService(bundled: Data?) {
    let config = NamuBuildConfig(
      bundleId: "org.namuai.offline.internal", isInternalBuild: true, appVersion: "1.0", appBuild: 1,
      runtimeBuildId: "llamarn-0.12.9-b10256", modelOrigin: server.origin,
      keys: [VerificationKey(keyId: "dev-test", publicKeyB64: key.publicKey.rawRepresentation.base64EncodedString())],
      bundledKnownBad: [], bundledDescriptor: bundled)
    service = TransferService(
      config: config, storeRoot: root, sessionIdentifier: "org.namuai.offline.tests.\(UUID().uuidString)")
    service.start()
  }

  // MARK: - Synchronous helpers

  private func call<T>(_ timeout: TimeInterval = 30, _ body: (@escaping (Result<T, NamuError>) -> Void) -> Void) throws -> T {
    let semaphore = DispatchSemaphore(value: 0)
    var result: Result<T, NamuError>?
    body { result = $0; semaphore.signal() }
    guard semaphore.wait(timeout: .now() + timeout) == .success, let result else {
      throw NamuError("TIMEOUT", "call did not complete")
    }
    return try result.get()
  }

  private func snapshot() throws -> [String: Any] {
    let json: String = try call { self.service.snapshot($0) }
    return try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
  }

  private func transfer(_ snapshot: [String: Any]) -> [String: Any]? { snapshot["transfer"] as? [String: Any] }

  @discardableResult
  private func waitForTransfer(
    _ description: String, timeout: TimeInterval = 60, _ predicate: ([String: Any]) -> Bool
  ) throws -> [String: Any] {
    let deadline = Date().addingTimeInterval(timeout)
    var last = [String: Any]()
    while Date() < deadline {
      let current = try snapshot()
      if let t = transfer(current) {
        last = t
        if predicate(t) { return t }
      }
      Thread.sleep(forTimeInterval: 0.1)
    }
    XCTFail("timed out waiting for \(description); last phase=\(last["phase"] ?? "nil") error=\(last["errorCode"] ?? "nil")")
    throw NamuError("TIMEOUT", description)
  }

  private func stagingFiles() -> [String] {
    (try? FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("staging").path)) ?? []
  }

  private func releases() -> [String] {
    (try? FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("releases").path)) ?? []
  }

  // MARK: - Tests

  func testFullInstallPipelineWithoutJavaScript() throws {
    let artifact = gguf()
    let sha = Data(SHA256.hash(data: artifact)).namuHex
    server.route("/" + path(sha)) { _ in LocalHTTPServer.Response(body: artifact) }
    makeService(bundled: try envelope(for: artifact))

    let summaryJSON: String = try call { self.service.bundledDescriptorSummary($0) }
    let summary = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(summaryJSON.utf8)) as? [String: Any])
    XCTAssertEqual(summary["valid"] as? Bool, true)
    XCTAssertEqual(summary["sha256"] as? String, sha)

    var initial = try snapshot()
    XCTAssertEqual((initial["install"] as? [String: Any])?["state"] as? String, "absent")
    XCTAssertTrue(initial["transfer"] is NSNull)

    let transferId: String = try call { self.service.start(source: "bundled", allowMetered: false, completion: $0) }
    // DL-001: idempotent by artifact while in flight and afterwards.
    let again: String = try call { self.service.start(source: "bundled", allowMetered: false, completion: $0) }
    XCTAssertEqual(again, transferId)

    let staged = try waitForTransfer("staged") { $0["phase"] as? String == "staged" }
    XCTAssertEqual(staged["transferId"] as? String, transferId)
    XCTAssertEqual(staged["committedBytes"] as? Int, artifact.count)
    XCTAssertEqual(staged["verifiedBytes"] as? Int, artifact.count)
    XCTAssertEqual(staged["isUpdate"] as? Bool, false)
    XCTAssertEqual(stagingFiles(), [], "staging file was renamed into the release")
    // Staged is not installed (DL-012).
    initial = try snapshot()
    XCTAssertEqual((initial["install"] as? [String: Any])?["state"] as? String, "absent")

    let candidate: String = try call { self.service.beginSelfTest(transferId: transferId, completion: $0) }
    XCTAssertEqual(candidate, sha)
    XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("pending-activation.json").path))
    let candidatePath: String = try call { self.service.resolveArtifactPath(artifactId: sha, completion: $0) }
    XCTAssertEqual(try Sha256Streamer.hashFile(at: URL(fileURLWithPath: candidatePath)), sha)

    let activatedJSON: String = try call {
      self.service.activate(transferId: transferId, selfTestPassed: true, failureCode: "", completion: $0)
    }
    let activated = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(activatedJSON.utf8)) as? [String: Any])
    let install = try XCTUnwrap(activated["install"] as? [String: Any])
    XCTAssertEqual(install["state"] as? String, "installed")
    XCTAssertEqual((install["active"] as? [String: Any])?["artifactId"] as? String, sha)
    XCTAssertEqual(transfer(activated)?["phase"] as? String, "installed")
    XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("pending-activation.json").path))
    XCTAssertEqual(server.requestCount("/" + path(sha)), 1)

    // DL-013 / SEC-006: a live runtime reference blocks removal.
    service.setRuntimeReference(sha)
    XCTAssertThrowsError(try call { (done: @escaping (Result<Void, NamuError>) -> Void) in self.service.removeModel(done) }) {
      XCTAssertEqual(($0 as? NamuError)?.code, "ENGINE_BUSY")
    }
    service.setRuntimeReference("")
    try call { (done: @escaping (Result<Void, NamuError>) -> Void) in self.service.removeModel(done) }
    XCTAssertEqual(releases(), [])
    XCTAssertEqual((try snapshot()["install"] as? [String: Any])?["state"] as? String, "absent")
  }

  /// T08: bytes that do not match the signed digest never become a release.
  func testHashMismatchIsFileDamagedAndRemovesOnlyStaging() throws {
    let signed = gguf(seed: 1)
    let served = gguf(seed: 2) // same length, different content
    let sha = Data(SHA256.hash(data: signed)).namuHex
    server.route("/" + path(sha)) { _ in LocalHTTPServer.Response(body: served) }
    makeService(bundled: try envelope(for: signed))

    _ = try call { self.service.start(source: "bundled", allowMetered: false, completion: $0) } as String
    let failed = try waitForTransfer("failed") { $0["phase"] as? String == "failed" }
    XCTAssertEqual(failed["errorCode"] as? String, "FILE_DAMAGED")
    XCTAssertEqual(stagingFiles(), [])
    XCTAssertEqual(releases(), [])
    XCTAssertEqual(server.requestCount("/" + path(sha)), 1, "hash failures never auto-retry")
  }

  /// T07: a body larger than the signed length is refused.
  func testOversizedBodyIsRefused() throws {
    let signed = gguf(size: 64 * 1024)
    let sha = Data(SHA256.hash(data: signed)).namuHex
    var oversized = signed
    oversized.append(Data(repeating: 9, count: 512 * 1024))
    server.route("/" + path(sha)) { _ in LocalHTTPServer.Response(body: oversized) }
    makeService(bundled: try envelope(for: signed))

    _ = try call { self.service.start(source: "bundled", allowMetered: false, completion: $0) } as String
    let failed = try waitForTransfer("failed") { $0["phase"] as? String == "failed" }
    XCTAssertEqual(failed["errorCode"] as? String, "FILE_DAMAGED")
    XCTAssertEqual(stagingFiles(), [])
    XCTAssertEqual(releases(), [])
  }

  /// T07 variant: endless-style body with no Content-Length.
  func testOversizedBodyWithoutContentLengthIsRefused() throws {
    let signed = gguf(size: 64 * 1024)
    let sha = Data(SHA256.hash(data: signed)).namuHex
    var oversized = signed
    oversized.append(Data(repeating: 9, count: 2 * 1024 * 1024))
    server.route("/" + path(sha)) { _ in
      LocalHTTPServer.Response(body: oversized, omitContentLength: true, sliceSize: 128 * 1024, sliceDelay: 0.02)
    }
    makeService(bundled: try envelope(for: signed))

    _ = try call { self.service.start(source: "bundled", allowMetered: false, completion: $0) } as String
    let failed = try waitForTransfer("failed") { $0["phase"] as? String == "failed" }
    XCTAssertEqual(failed["errorCode"] as? String, "FILE_DAMAGED")
    XCTAssertEqual(releases(), [])
  }

  func testArchitectureMismatchIsModelIncompatible() throws {
    let artifact = gguf(architecture: "cohere2")
    let sha = Data(SHA256.hash(data: artifact)).namuHex
    server.route("/" + path(sha)) { _ in LocalHTTPServer.Response(body: artifact) }
    makeService(bundled: try envelope(for: artifact, architecture: "llama")) // signed metadata says llama

    _ = try call { self.service.start(source: "bundled", allowMetered: false, completion: $0) } as String
    let failed = try waitForTransfer("failed") { $0["phase"] as? String == "failed" }
    XCTAssertEqual(failed["errorCode"] as? String, "MODEL_INCOMPATIBLE")
    XCTAssertEqual(releases(), [])
  }

  func testStructurallyBrokenGGUFIsFileDamaged() throws {
    let artifact = Data(repeating: 0x41, count: 32 * 1024) // right hash, not a GGUF
    let sha = Data(SHA256.hash(data: artifact)).namuHex
    server.route("/" + path(sha)) { _ in LocalHTTPServer.Response(body: artifact) }
    makeService(bundled: try envelope(for: artifact))

    _ = try call { self.service.start(source: "bundled", allowMetered: false, completion: $0) } as String
    let failed = try waitForTransfer("failed") { $0["phase"] as? String == "failed" }
    XCTAssertEqual(failed["errorCode"] as? String, "FILE_DAMAGED")
  }

  /// T08: an untrusted descriptor never starts a transfer.
  func testUntrustedBundledDescriptorIsRejectedBeforeAnyRequest() throws {
    let artifact = gguf()
    let sha = Data(SHA256.hash(data: artifact)).namuHex
    makeService(bundled: try envelope(for: artifact, signer: Curve25519.Signing.PrivateKey()))

    XCTAssertThrowsError(try call { self.service.start(source: "bundled", allowMetered: false, completion: $0) } as String) {
      XCTAssertEqual(($0 as? NamuError)?.code, "SIGNATURE_INVALID")
    }
    XCTAssertTrue(try snapshot()["transfer"] is NSNull)
    XCTAssertEqual(server.requestCount("/" + path(sha)), 0)
    let summaryJSON: String = try call { self.service.bundledDescriptorSummary($0) }
    XCTAssertTrue(summaryJSON.contains("\"valid\":false"))
    XCTAssertTrue(summaryJSON.contains("SIGNATURE_INVALID"))
  }

  func testMissingBundledDescriptorReportsInvalid() throws {
    makeService(bundled: nil)
    let summaryJSON: String = try call { self.service.bundledDescriptorSummary($0) }
    XCTAssertTrue(summaryJSON.contains("\"valid\":false"))
    XCTAssertThrowsError(try call { self.service.start(source: "bundled", allowMetered: false, completion: $0) } as String) {
      XCTAssertEqual(($0 as? NamuError)?.code, "SIGNATURE_INVALID")
    }
  }

  /// DL-007: other 4xx answers are never retried automatically.
  func testNotFoundRequiresUserRetry() throws {
    let artifact = gguf()
    let sha = Data(SHA256.hash(data: artifact)).namuHex
    makeService(bundled: try envelope(for: artifact)) // no route → 404

    let transferId: String = try call { self.service.start(source: "bundled", allowMetered: false, completion: $0) }
    let failed = try waitForTransfer("failed") { $0["phase"] as? String == "failed" }
    XCTAssertEqual(failed["errorCode"] as? String, "TRANSFER_RETRY")
    Thread.sleep(forTimeInterval: 3)
    XCTAssertEqual(server.requestCount("/" + path(sha)), 1)

    // Cancel is idempotent and clears the transfer.
    try call { (done: @escaping (Result<Void, NamuError>) -> Void) in self.service.cancel(transferId: transferId, completion: done) }
    try call { (done: @escaping (Result<Void, NamuError>) -> Void) in self.service.cancel(transferId: transferId, completion: done) }
    XCTAssertTrue(try snapshot()["transfer"] is NSNull)
  }

  /// DL-007: 5xx enters back-off (waiting/TRANSFER_RETRY with nextRetryAt) and
  /// the OS-scheduled retry completes the transfer.
  func testServerErrorBacksOffThenSucceeds() throws {
    let artifact = gguf()
    let sha = Data(SHA256.hash(data: artifact)).namuHex
    server.route("/" + path(sha)) { count in
      count == 1 ? LocalHTTPServer.Response(status: 503, body: Data("busy".utf8)) : LocalHTTPServer.Response(body: artifact)
    }
    makeService(bundled: try envelope(for: artifact))

    _ = try call { self.service.start(source: "bundled", allowMetered: false, completion: $0) } as String
    let waiting = try waitForTransfer("back-off") { $0["phase"] as? String == "waiting" && $0["errorCode"] as? String == "TRANSFER_RETRY" }
    XCTAssertEqual(waiting["retryCount"] as? Int, 1)
    let next = try XCTUnwrap(waiting["nextRetryAt"] as? Int64 ?? (waiting["nextRetryAt"] as? NSNumber)?.int64Value)
    XCTAssertGreaterThanOrEqual(next - namuNowMs(), 0)
    XCTAssertLessThanOrEqual(next - namuNowMs(), 2_500)

    let staged = try waitForTransfer("staged after retry", timeout: 120) { $0["phase"] as? String == "staged" }
    XCTAssertEqual(staged["retryCount"] as? Int, 0, "progress resets the consecutive-failure counter")
    XCTAssertEqual(server.requestCount("/" + path(sha)), 2)
  }

  /// DL-005/DL-006: pause is persistent; a resume without usable resume data
  /// restarts from zero and says so (TRANSFER_RESTART semantics).
  func testPauseThenResumeRestartsHonestly() throws {
    let artifact = gguf(size: 4 * 1024 * 1024)
    let sha = Data(SHA256.hash(data: artifact)).namuHex
    server.route("/" + path(sha)) { count in
      // First request crawls (no validators → the OS cannot produce resume
      // data); the second is fast.
      count == 1
        ? LocalHTTPServer.Response(body: artifact, sliceSize: 64 * 1024, sliceDelay: 0.25)
        : LocalHTTPServer.Response(body: artifact)
    }
    makeService(bundled: try envelope(for: artifact))

    let transferId: String = try call { self.service.start(source: "bundled", allowMetered: false, completion: $0) }
    try waitForTransfer("first bytes") { ($0["committedBytes"] as? Int ?? 0) > 0 }
    try call { (done: @escaping (Result<Void, NamuError>) -> Void) in self.service.pause(transferId: transferId, completion: done) }
    let paused = try XCTUnwrap(transfer(try snapshot()))
    XCTAssertEqual(paused["phase"] as? String, "paused")
    XCTAssertEqual(paused["userPaused"] as? Bool, true)
    Thread.sleep(forTimeInterval: 1.5)
    XCTAssertEqual(transfer(try snapshot())?["phase"] as? String, "paused", "pause persists until resume")

    try call { (done: @escaping (Result<Void, NamuError>) -> Void) in
      self.service.resume(transferId: transferId, allowMetered: false, completion: done)
    }
    let staged = try waitForTransfer("staged after resume", timeout: 120) { $0["phase"] as? String == "staged" }
    XCTAssertEqual(staged["userPaused"] as? Bool, false)
    XCTAssertEqual(staged["restartedFromZero"] as? Bool, true, "no resume data → visible restart, never a silent one")
    XCTAssertEqual(staged["verifiedBytes"] as? Int, artifact.count)
  }

  /// Downloads, verifies, self-tests and activates whatever `source` points at.
  private func installThroughPipeline(source: String) throws -> String {
    let transferId: String = try call { self.service.start(source: source, allowMetered: false, completion: $0) }
    try waitForTransfer("\(source) staged") { $0["transferId"] as? String == transferId && $0["phase"] as? String == "staged" }
    let artifactId: String = try call { self.service.beginSelfTest(transferId: transferId, completion: $0) }
    _ = try call { self.service.activate(transferId: transferId, selfTestPassed: true, failureCode: "", completion: $0) } as String
    return artifactId
  }

  /// DL-013: update A → B, then the two restore flavours of the contract.
  func testRestorePreviousManualSwapAndFailedTrial() throws {
    let first = gguf(seed: 1)
    let second = gguf(seed: 2)
    let firstSha = Data(SHA256.hash(data: first)).namuHex
    let secondSha = Data(SHA256.hash(data: second)).namuHex
    server.route("/" + path(firstSha)) { _ in LocalHTTPServer.Response(body: first) }
    server.route("/" + path(secondSha)) { _ in LocalHTTPServer.Response(body: second) }
    let stable = try envelope(for: second, sequence: 2)
    server.route("/releases/stable.json") { _ in LocalHTTPServer.Response(body: stable) }
    makeService(bundled: try envelope(for: first))

    XCTAssertEqual(try installThroughPipeline(source: "bundled"), firstSha)
    _ = try call { self.service.checkForUpdate($0) } as String
    XCTAssertEqual(try installThroughPipeline(source: "update"), secondSha)

    func install() throws -> [String: Any] { try XCTUnwrap(try snapshot()["install"] as? [String: Any]) }
    XCTAssertEqual((try install()["active"] as? [String: Any])?["artifactId"] as? String, secondSha)
    XCTAssertEqual((try install()["previous"] as? [String: Any])?["artifactId"] as? String, firstSha)
    XCTAssertEqual(try install()["canRestorePrevious"] as? Bool, true)
    XCTAssertTrue(try snapshot()["update"] is NSNull, "the installed update is no longer advertised")

    // Manual "Restore previous version": a swap, nothing is marked bad.
    _ = try call { self.service.restorePrevious(markAbandonedBad: false, completion: $0) } as String
    XCTAssertEqual((try install()["active"] as? [String: Any])?["artifactId"] as? String, firstSha)
    XCTAssertEqual((try install()["previous"] as? [String: Any])?["artifactId"] as? String, secondSha)
    XCTAssertEqual(Set(releases()), [firstSha, secondSha])

    // Swap forward again, then the automatic failed-trial restore.
    _ = try call { self.service.restorePrevious(markAbandonedBad: false, completion: $0) } as String
    service.setRuntimeReference(secondSha)
    XCTAssertThrowsError(try call { self.service.restorePrevious(markAbandonedBad: true, completion: $0) } as String) {
      XCTAssertEqual(($0 as? NamuError)?.code, "ENGINE_BUSY")
    }
    service.setRuntimeReference("")
    _ = try call { self.service.restorePrevious(markAbandonedBad: true, completion: $0) } as String
    XCTAssertEqual((try install()["active"] as? [String: Any])?["artifactId"] as? String, firstSha)
    XCTAssertTrue(try install()["previous"] is NSNull)
    XCTAssertEqual(try install()["canRestorePrevious"] as? Bool, false)
    XCTAssertEqual(releases(), [firstSha], "the abandoned release is removed")

    // The abandoned digest is locally bad: it can never be offered again.
    XCTAssertThrowsError(try call { self.service.start(source: "update", allowMetered: false, completion: $0) } as String) {
      XCTAssertEqual(($0 as? NamuError)?.code, "FILE_DAMAGED")
    }
  }

  /// SIG-005 / T29: user-initiated update check; replayed metadata is refused.
  func testCheckForUpdateAcceptsNewerAndRejectsReplay() throws {
    let installed = gguf(seed: 1)
    let update = gguf(seed: 3)
    let updateSha = Data(SHA256.hash(data: update)).namuHex
    func publish(_ envelope: Data) { server.route("/releases/stable.json") { _ in LocalHTTPServer.Response(body: envelope) } }
    publish(try envelope(for: update, sequence: 7))
    server.route("/" + path(updateSha)) { _ in LocalHTTPServer.Response(body: update) }
    makeService(bundled: try envelope(for: installed))

    var resultJSON: String = try call { self.service.checkForUpdate($0) }
    XCTAssertTrue(resultJSON.contains("\"status\":\"available\""), resultJSON)
    let advertised = try XCTUnwrap(try snapshot()["update"] as? [String: Any])
    XCTAssertEqual(advertised["sequence"] as? Int, 7)
    XCTAssertEqual(advertised["bytes"] as? Int, update.count)
    // SIG-005: checking never starts a transfer by itself.
    XCTAssertTrue(try snapshot()["transfer"] is NSNull)

    // A lower sequence afterwards is a replay.
    publish(try envelope(for: installed, sequence: 3))
    resultJSON = try call { self.service.checkForUpdate($0) }
    XCTAssertTrue(resultJSON.contains("\"status\":\"error\""), resultJSON)
    XCTAssertTrue(resultJSON.contains("SIGNATURE_INVALID"), resultJSON)

    // Same sequence with a different payload is refused as well (T29).
    publish(try envelope(for: installed, sequence: 7))
    resultJSON = try call { self.service.checkForUpdate($0) }
    XCTAssertTrue(resultJSON.contains("SIGNATURE_INVALID"), resultJSON)

    // The accepted update can be started explicitly.
    _ = try call { self.service.start(source: "update", allowMetered: false, completion: $0) } as String
    let staged = try waitForTransfer("update staged") { $0["phase"] as? String == "staged" }
    XCTAssertEqual(staged["isUpdate"] as? Bool, true)
    XCTAssertEqual(staged["artifactSha256"] as? String, updateSha)
  }
}
