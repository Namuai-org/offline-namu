import Foundation
import XCTest
@testable import Namu

enum TestSupport {
  /// Fresh directory under the test process's temporary directory.
  static func makeTemporaryDirectory(_ name: String = "namu-tests") throws -> URL {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("\(name)-\(UUID().uuidString.lowercased())", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  static func remove(_ url: URL?) {
    guard let url else { return }
    // Release files are 0444 inside 0755 directories; removal still works
    // because unlink permission comes from the directory.
    try? FileManager.default.removeItem(at: url)
  }

  static func sha(_ character: Character) -> String {
    String(repeating: character, count: 64)
  }

  static func transfer(
    artifact: String, phase: TransferPhase, bytes: Int64 = 16, version: String = "test-1",
    id: String = UUID().uuidString.lowercased(), createdAt: Int64 = namuNowMs()
  ) -> TransferRecord {
    TransferRecord(
      transferId: id, descriptorSource: "bundled", descriptorBytes: Data("{}".utf8), descriptorHash: sha("0"),
      artifactVersion: version, artifactSha256: artifact, artifactPath: "models/aya-global-q4km/\(artifact)/model.gguf",
      phase: phase, expectedBytes: bytes, createdAt: createdAt, updatedAt: createdAt)
  }

  /// Puts a verified-looking release of `bytes` bytes under releases/<artifact>.
  static func installRelease(_ store: ModelStore, artifact: String, bytes: Int = 16) throws {
    let staging = try store.stagingURL(transferId: UUID().uuidString.lowercased())
    try Data(repeating: 0x5a, count: bytes).write(to: staging)
    try store.installVerifiedFile(from: staging, artifactId: artifact, expectedBytes: Int64(bytes))
  }
}
