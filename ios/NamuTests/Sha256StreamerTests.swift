import CryptoKit
import XCTest
@testable import Namu

final class Sha256StreamerTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws { directory = try TestSupport.makeTemporaryDirectory("sha") }
  override func tearDown() { TestSupport.remove(directory) }

  func testMatchesOneShotDigestAndReportsProgress() throws {
    var data = Data(count: 3 * 1024 * 1024 + 17)
    for i in stride(from: 0, to: data.count, by: 4099) { data[i] = UInt8(truncatingIfNeeded: i) }
    let url = directory.appendingPathComponent("blob")
    try data.write(to: url)
    var progress = [Int64]()
    let digest = try Sha256Streamer.hashFile(at: url, bufferSize: 1024 * 1024, progress: { progress.append($0) })
    XCTAssertEqual(digest, Data(SHA256.hash(data: data)).namuHex)
    XCTAssertEqual(progress.last, Int64(data.count))
    XCTAssertEqual(progress, progress.sorted())
    XCTAssertGreaterThanOrEqual(progress.count, 4)
  }

  func testKnownVectorAndEmptyFile() throws {
    let url = directory.appendingPathComponent("abc")
    try Data("abc".utf8).write(to: url)
    XCTAssertEqual(try Sha256Streamer.hashFile(at: url), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    let empty = directory.appendingPathComponent("empty")
    try Data().write(to: empty)
    XCTAssertEqual(try Sha256Streamer.hashFile(at: empty), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  }

  func testCancellation() throws {
    let url = directory.appendingPathComponent("blob")
    try Data(count: 1024 * 1024).write(to: url)
    XCTAssertThrowsError(try Sha256Streamer.hashFile(at: url, bufferSize: 1024, isCancelled: { true }))
  }
}
