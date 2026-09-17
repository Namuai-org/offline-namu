import XCTest
@testable import Namu

/// DL-012 / T10: durable pointer replacement with crash injection.
final class ActivePointerTests: XCTestCase {
  private var directory: URL!
  private var store: ActivePointerStore!

  override func setUpWithError() throws {
    directory = try TestSupport.makeTemporaryDirectory("pointer")
    store = ActivePointerStore(url: directory.appendingPathComponent("active.json"))
  }

  override func tearDown() {
    DurableFile.crashHook = nil
    TestSupport.remove(directory)
  }

  private func pointer(_ character: Character, previous: Character? = nil) -> ActivePointer {
    func entry(_ c: Character) -> ActiveEntry {
      ActiveEntry(artifactId: TestSupport.sha(c), version: "v-\(c)", bytes: 100, sha256: TestSupport.sha(c), activatedAt: 1)
    }
    return ActivePointer(active: entry(character), previous: previous.map(entry), trial: TrialState(startedAt: 1, successfulSessions: 0))
  }

  func testRoundTripAndSchema() throws {
    XCTAssertNil(store.load())
    try store.write(pointer("a", previous: "b"))
    XCTAssertEqual(store.load(), pointer("a", previous: "b"))
    let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: store.url)) as? [String: Any])
    XCTAssertEqual(json["schema"] as? Int, 1)
    XCTAssertEqual((json["active"] as? [String: Any])?["artifactId"] as? String, TestSupport.sha("a"))
    XCTAssertNotNil(json["trial"])
    XCTAssertFalse(FileManager.default.fileExists(atPath: DurableFile.tempURL(for: store.url).path))
  }

  func testRejectsStructurallyInvalidPointers() throws {
    var bad = pointer("a")
    bad.active.sha256 = TestSupport.sha("b") // digest and artifact ID must agree
    XCTAssertThrowsError(try store.write(bad))
    XCTAssertThrowsError(try store.write(pointer("a", previous: "a")))
    try Data("{\"schema\":2}".utf8).write(to: store.url)
    XCTAssertNil(store.load())
    try Data(count: ActivePointerStore.maxBytes + 1).write(to: store.url)
    XCTAssertNil(store.load())
  }

  /// T10: kill at each checkpoint while replacing A with B. Afterwards there
  /// is exactly one valid pointer: A before the rename, B from the rename on.
  func testCrashAtEveryCheckpointLeavesExactlyOneValidPointer() throws {
    for checkpoint in DurableFile.Checkpoint.allCases {
      try? FileManager.default.removeItem(at: store.url)
      DurableFile.crashHook = nil
      try store.write(pointer("a"))

      DurableFile.crashHook = { reached, _ in
        if reached == checkpoint { throw DurableFile.SimulatedCrash(checkpoint: checkpoint) }
      }
      XCTAssertThrowsError(try store.write(pointer("b", previous: "a")), "\(checkpoint)") { error in
        XCTAssertEqual(error as? DurableFile.SimulatedCrash, DurableFile.SimulatedCrash(checkpoint: checkpoint))
      }
      DurableFile.crashHook = nil

      // "Relaunch": a new store instance reads whatever is on disk.
      let recovered = ActivePointerStore(url: store.url).load()
      let committed: Set<DurableFile.Checkpoint> = [.renamed, .directorySynced]
      XCTAssertEqual(recovered, committed.contains(checkpoint) ? pointer("b", previous: "a") : pointer("a"), "\(checkpoint)")
      // The temp file is never promoted and never survives recovery.
      XCTAssertFalse(FileManager.default.fileExists(atPath: DurableFile.tempURL(for: store.url).path), "\(checkpoint)")
      let leftovers = try FileManager.default.contentsOfDirectory(atPath: directory.path)
      XCTAssertEqual(leftovers, ["active.json"], "\(checkpoint)")
    }
  }

  func testCrashDuringFirstActivationNeverPromotesTemp() throws {
    for checkpoint in DurableFile.Checkpoint.allCases {
      try? FileManager.default.removeItem(at: store.url)
      DurableFile.crashHook = { reached, _ in
        if reached == checkpoint { throw DurableFile.SimulatedCrash(checkpoint: checkpoint) }
      }
      XCTAssertThrowsError(try store.write(pointer("b")))
      DurableFile.crashHook = nil
      let recovered = ActivePointerStore(url: store.url).load()
      let committed: Set<DurableFile.Checkpoint> = [.renamed, .directorySynced]
      XCTAssertEqual(recovered, committed.contains(checkpoint) ? pointer("b") : nil, "\(checkpoint)")
    }
  }

  func testCorruptPointerWithValidTempIsTreatedAsMissing() throws {
    try Data("garbage".utf8).write(to: store.url)
    try pointer("b").encoded().write(to: DurableFile.tempURL(for: store.url))
    XCTAssertNil(store.load(), "a .tmp must never be promoted")
    XCTAssertFalse(FileManager.default.fileExists(atPath: DurableFile.tempURL(for: store.url).path))
  }

  func testTornTempFileIsReallyTorn() throws {
    try store.write(pointer("a"))
    var tornSize = -1
    DurableFile.crashHook = { reached, url in
      if reached == .tempPartiallyWritten {
        tornSize = (try? Data(contentsOf: DurableFile.tempURL(for: url)).count) ?? -1
        throw DurableFile.SimulatedCrash(checkpoint: reached)
      }
    }
    XCTAssertThrowsError(try store.write(pointer("b")))
    let full = try pointer("b").encoded().count
    XCTAssertGreaterThan(tornSize, 0)
    XCTAssertLessThan(tornSize, full)
  }

  func testDurableRemove() throws {
    try store.write(pointer("a"))
    try store.clear()
    XCTAssertNil(store.load())
    XCTAssertNoThrow(try store.clear(), "clearing twice is fine")
  }
}
