import XCTest
@testable import Namu

/// Startup reconciliation, activation and retention (DL-012…014, contract §6.4).
final class ModelStoreTests: XCTestCase {
  private var root: URL!
  private let a = TestSupport.sha("a")
  private let b = TestSupport.sha("b")

  override func setUpWithError() throws { root = try TestSupport.makeTemporaryDirectory("store") }

  override func tearDown() {
    DurableFile.crashHook = nil
    TestSupport.remove(root)
  }

  /// A new instance over the same root is what the next process launch sees.
  private func launch(knownBad: Set<String> = []) throws -> ModelStore {
    let store = try ModelStore(root: root, bundledKnownBad: knownBad)
    try store.reconcile()
    return store
  }

  /// Runs the install pipeline's tail for one artifact: staged → selfTesting → activate.
  @discardableResult
  private func install(_ store: ModelStore, artifact: String, now: Int64 = namuNowMs()) throws -> TransferRecord {
    try TestSupport.installRelease(store, artifact: artifact)
    var record = TestSupport.transfer(artifact: artifact, phase: .selfTesting, createdAt: now)
    try store.journal.insert(record)
    try store.writeMarker(PendingActivationMarker(transferId: record.transferId, artifactId: artifact, startedAt: now))
    try store.activate(transfer: record, now: now)
    record = try XCTUnwrap(try store.journal.transfer(id: record.transferId))
    return record
  }

  // MARK: - Layout

  func testLayoutIsCreatedAndExcludedFromBackup() throws {
    let store = try launch()
    for directory in [store.stagingDirectory, store.releasesDirectory, root.appendingPathComponent("journal")] {
      var isDirectory: ObjCBool = false
      XCTAssertTrue(FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory) && isDirectory.boolValue)
    }
    XCTAssertEqual(try root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    XCTAssertEqual(store.installState, .absent)
    XCTAssertNil(store.pointer)
  }

  func testPathsOnlyAcceptAppGeneratedIdentifiers() throws {
    let store = try launch()
    XCTAssertThrowsError(try store.stagingURL(transferId: "../../etc/passwd"))
    XCTAssertThrowsError(try store.releaseFileURL(artifactId: "../" + String(repeating: "a", count: 61)))
    XCTAssertThrowsError(try store.releaseFileURL(artifactId: String(repeating: "A", count: 64)))
    XCTAssertNoThrow(try store.releaseFileURL(artifactId: a))
  }

  // MARK: - Activation

  func testActivationCommitsPointerJournalAndMarker() throws {
    let store = try launch()
    let record = try install(store, artifact: a, now: 5000)
    XCTAssertEqual(record.phase, .installed)
    XCTAssertEqual(store.installState, .installed)
    XCTAssertEqual(store.pointer?.active.artifactId, a)
    XCTAssertNil(store.pointer?.previous)
    XCTAssertEqual(store.pointer?.trial, TrialState(startedAt: 5000, successfulSessions: 0))
    XCTAssertNil(store.readMarker())
    let mirror = try XCTUnwrap(try store.journal.meta(TransferJournal.MetaKey.activeMirror))
    XCTAssertEqual(try JSONDecoder().decode(ActivePointer.self, from: Data(mirror.utf8)), store.pointer)
    // Installed files are read-only.
    let mode = try FileManager.default.attributesOfItem(atPath: store.releaseFileURL(artifactId: a).path)[.posixPermissions] as? NSNumber
    XCTAssertEqual(mode?.intValue, 0o444)

    let relaunched = try launch()
    XCTAssertEqual(relaunched.installState, .installed)
    XCTAssertEqual(relaunched.pointer, store.pointer)
  }

  func testUpdateKeepsExactlyOnePreviousVersion() throws {
    let store = try launch()
    try install(store, artifact: a)
    try install(store, artifact: b)
    XCTAssertEqual(store.pointer?.active.artifactId, b)
    XCTAssertEqual(store.pointer?.previous?.artifactId, a)
    XCTAssertTrue(store.canRestorePrevious)

    let c = TestSupport.sha("c")
    try install(store, artifact: c)
    XCTAssertEqual(store.pointer?.previous?.artifactId, b)
    XCTAssertFalse(store.releaseIsIntact(artifactId: a, bytes: 16), "the older previous version is dropped")
    XCTAssertNil(try store.journal.transfer(artifactSha256: a))
  }

  func testFailedSelfTestQuarantinesCandidateAndKeepsOldPointer() throws {
    let store = try launch()
    try install(store, artifact: a)
    try TestSupport.installRelease(store, artifact: b)
    let candidate = TestSupport.transfer(artifact: b, phase: .selfTesting)
    try store.journal.insert(candidate)
    try store.writeMarker(PendingActivationMarker(transferId: candidate.transferId, artifactId: b, startedAt: 1))

    try store.failActivation(transfer: candidate, code: "MODEL_LOAD_FAILED")

    XCTAssertEqual(store.pointer?.active.artifactId, a, "old pointer untouched")
    XCTAssertTrue(store.knownBad().contains(b))
    XCTAssertFalse(store.releaseIsIntact(artifactId: b, bytes: 16))
    XCTAssertNil(store.readMarker())
    let row = try XCTUnwrap(try store.journal.transfer(id: candidate.transferId))
    XCTAssertEqual(row.phase, .failed)
    XCTAssertEqual(row.lastError, "MODEL_LOAD_FAILED")
    XCTAssertEqual(try launch().installState, .installed)
  }

  // MARK: - Reconciliation

  func testPendingMarkerQuarantinesCandidateOnNextLaunch() throws {
    let store = try launch()
    try install(store, artifact: a)
    try TestSupport.installRelease(store, artifact: b)
    let candidate = TestSupport.transfer(artifact: b, phase: .selfTesting)
    try store.journal.insert(candidate)
    try store.writeMarker(PendingActivationMarker(transferId: candidate.transferId, artifactId: b, startedAt: 1))
    // — process dies during the self-test —

    let relaunched = try launch()
    XCTAssertEqual(relaunched.installState, .installed)
    XCTAssertEqual(relaunched.pointer?.active.artifactId, a)
    XCTAssertTrue(relaunched.knownBad().contains(b), "candidate digest is locally bad")
    XCTAssertFalse(FileManager.default.fileExists(atPath: try relaunched.releaseDirectory(artifactId: b).path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: relaunched.markerURL.path))
    let row = try XCTUnwrap(try relaunched.journal.transfer(id: candidate.transferId))
    XCTAssertEqual(row.phase, .failed)
    XCTAssertEqual(row.lastError, "MODEL_LOAD_FAILED")
  }

  func testMarkerLeftAfterCommittedActivationDoesNotQuarantine() throws {
    let store = try launch()
    let record = try install(store, artifact: a)
    // Crash between the pointer rename and the marker removal.
    try store.writeMarker(PendingActivationMarker(transferId: record.transferId, artifactId: a, startedAt: 1))
    var stale = record
    stale.phase = .selfTesting
    try store.journal.save(stale)

    let relaunched = try launch()
    XCTAssertEqual(relaunched.installState, .installed)
    XCTAssertFalse(relaunched.knownBad().contains(a))
    XCTAssertEqual(try relaunched.journal.transfer(id: record.transferId)?.phase, .installed)
    XCTAssertNil(relaunched.readMarker())
  }

  func testVerifiedReleaseWithoutPointerStaysStaged() throws {
    let store = try launch()
    try TestSupport.installRelease(store, artifact: a)
    // The journal claims "installed", but the pointer is the authority.
    let record = TestSupport.transfer(artifact: a, phase: .installed)
    try store.journal.insert(record)

    let relaunched = try launch()
    XCTAssertEqual(relaunched.installState, .absent)
    XCTAssertNil(relaunched.pointer)
    XCTAssertEqual(try relaunched.journal.transfer(id: record.transferId)?.phase, .staged)
    XCTAssertTrue(relaunched.releaseIsIntact(artifactId: a, bytes: 16), "the verified release is kept")
    XCTAssertNil(try relaunched.journal.meta(TransferJournal.MetaKey.activeMirror))
  }

  func testMissingOrTruncatedFileNeedsRepair() throws {
    let store = try launch()
    try install(store, artifact: a)
    let file = try store.releaseFileURL(artifactId: a)

    chmod(file.path, 0o644)
    try Data(count: 3).write(to: file) // wrong length, no rehash needed (DL-014)
    XCTAssertEqual(try launch().installState, .needsRepair)

    try FileManager.default.removeItem(at: file)
    let relaunched = try launch()
    XCTAssertEqual(relaunched.installState, .needsRepair)
    XCTAssertEqual(relaunched.pointer?.active.artifactId, a, "the pointer is kept for the repair flow")
  }

  func testCorruptPointerWithTempIsAbsentAndTempIsNeverPromoted() throws {
    let store = try launch()
    try install(store, artifact: a)
    let pointerData = try Data(contentsOf: store.pointerURL)
    try Data("{".utf8).write(to: store.pointerURL)
    try pointerData.write(to: DurableFile.tempURL(for: store.pointerURL))

    let relaunched = try launch()
    XCTAssertEqual(relaunched.installState, .absent)
    XCTAssertNil(relaunched.pointer)
    XCTAssertFalse(FileManager.default.fileExists(atPath: DurableFile.tempURL(for: store.pointerURL).path))
    // The verified release survives as a staged transfer.
    XCTAssertEqual(try relaunched.journal.transfer(artifactSha256: a)?.phase, .staged)
  }

  func testJournalMirrorIsRewrittenFromPointer() throws {
    let store = try launch()
    try install(store, artifact: a)
    try store.journal.setMeta(TransferJournal.MetaKey.activeMirror, "{\"tampered\":true}")
    let relaunched = try launch()
    let mirror = try XCTUnwrap(try relaunched.journal.meta(TransferJournal.MetaKey.activeMirror))
    XCTAssertEqual(try JSONDecoder().decode(ActivePointer.self, from: Data(mirror.utf8)), relaunched.pointer)
  }

  func testCrashBetweenReleaseRenameAndJournalCommitBecomesStaged() throws {
    let store = try launch()
    try TestSupport.installRelease(store, artifact: a)
    let record = TestSupport.transfer(artifact: a, phase: .verifying)
    try store.journal.insert(record)
    let relaunched = try launch()
    XCTAssertEqual(try relaunched.journal.transfer(id: record.transferId)?.phase, .staged)
    XCTAssertEqual(relaunched.installState, .absent)
  }

  func testOrphanFilesAreSwept() throws {
    let store = try launch()
    try TestSupport.installRelease(store, artifact: a) // no journal row, no pointer
    let strayStaging = try store.stagingURL(transferId: UUID().uuidString.lowercased())
    try Data(count: 8).write(to: strayStaging)
    let relaunched = try launch()
    XCTAssertFalse(FileManager.default.fileExists(atPath: try relaunched.releaseDirectory(artifactId: a).path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: strayStaging.path))
  }

  /// T10 end to end: kill at each activation checkpoint while updating A → B.
  func testCrashAtEachActivationCheckpointRecoversDeterministically() throws {
    for checkpoint in DurableFile.Checkpoint.allCases {
      TestSupport.remove(root)
      root = try TestSupport.makeTemporaryDirectory("store")
      let store = try launch()
      try install(store, artifact: a)
      try TestSupport.installRelease(store, artifact: b)
      let candidate = TestSupport.transfer(artifact: b, phase: .selfTesting)
      try store.journal.insert(candidate)
      try store.writeMarker(PendingActivationMarker(transferId: candidate.transferId, artifactId: b, startedAt: 1))

      DurableFile.crashHook = { reached, url in
        if url.lastPathComponent == "active.json", reached == checkpoint {
          throw DurableFile.SimulatedCrash(checkpoint: checkpoint)
        }
      }
      XCTAssertThrowsError(try store.activate(transfer: candidate), "\(checkpoint)")
      DurableFile.crashHook = nil

      let relaunched = try launch()
      let pointer = try XCTUnwrap(relaunched.pointer, "\(checkpoint): exactly one valid pointer must remain")
      XCTAssertEqual(relaunched.installState, .installed, "\(checkpoint)")
      XCTAssertNil(relaunched.readMarker(), "\(checkpoint)")
      let committed: Set<DurableFile.Checkpoint> = [.renamed, .directorySynced]
      if committed.contains(checkpoint) {
        XCTAssertEqual(pointer.active.artifactId, b, "\(checkpoint)")
        XCTAssertEqual(pointer.previous?.artifactId, a, "\(checkpoint)")
        XCTAssertEqual(try relaunched.journal.transfer(id: candidate.transferId)?.phase, .installed, "\(checkpoint)")
        XCTAssertFalse(relaunched.knownBad().contains(b), "\(checkpoint)")
      } else {
        XCTAssertEqual(pointer.active.artifactId, a, "\(checkpoint)")
        XCTAssertEqual(try relaunched.journal.transfer(id: candidate.transferId)?.phase, .failed, "\(checkpoint)")
        XCTAssertTrue(relaunched.knownBad().contains(b), "\(checkpoint): interrupted self-test quarantines")
      }
      // Recovery is deterministic: a second launch changes nothing.
      let again = try launch()
      XCTAssertEqual(again.pointer, pointer, "\(checkpoint)")
      XCTAssertEqual(again.installState, .installed, "\(checkpoint)")
    }
  }

  // MARK: - Retention and restore (DL-013)

  func testPreviousIsKeptUntilSevenDaysAndThreeSessions() throws {
    let store = try launch()
    let day: Int64 = 24 * 3600 * 1000
    try install(store, artifact: a, now: 0)
    try install(store, artifact: b, now: 1000)

    try store.noteSuccessfulSession(now: 1000 + 8 * day) // 1 session, > 7 days
    XCTAssertNotNil(store.pointer?.previous)
    try store.noteSuccessfulSession(now: 2000)
    try store.noteSuccessfulSession(now: 3000) // 3 sessions, < 7 days
    XCTAssertNotNil(store.pointer?.previous)
    XCTAssertEqual(store.pointer?.trial.successfulSessions, 3)

    store.runtimeReference = a // live runtime reference blocks deletion
    store.applyRetention(now: 1000 + 8 * day)
    XCTAssertNotNil(store.pointer?.previous)
    XCTAssertTrue(store.releaseIsIntact(artifactId: a, bytes: 16))

    store.runtimeReference = nil
    store.applyRetention(now: 1000 + 8 * day)
    XCTAssertNil(store.pointer?.previous)
    XCTAssertFalse(store.releaseIsIntact(artifactId: a, bytes: 16))
    XCTAssertFalse(store.canRestorePrevious)
    XCTAssertEqual(try launch().pointer?.active.artifactId, b)
  }

  func testUserRestoreSwapsWithoutMarkingBad() throws {
    let store = try launch()
    try install(store, artifact: a)
    try install(store, artifact: b)
    try store.restorePrevious(mode: .userSwap, now: 99)
    XCTAssertEqual(store.pointer?.active.artifactId, a)
    XCTAssertEqual(store.pointer?.previous?.artifactId, b)
    XCTAssertEqual(store.pointer?.trial, TrialState(startedAt: 99, successfulSessions: 0))
    XCTAssertFalse(store.knownBad().contains(b))
    XCTAssertEqual(try launch().pointer?.active.artifactId, a)
  }

  func testFailedTrialRestoreMarksAbandonedDigestBad() throws {
    let store = try launch()
    try install(store, artifact: a)
    try install(store, artifact: b)
    store.runtimeReference = b
    XCTAssertThrowsError(try store.restorePrevious(mode: .failedTrial)) { error in
      XCTAssertEqual((error as? NamuError)?.code, "ENGINE_BUSY")
    }
    store.runtimeReference = nil
    try store.restorePrevious(mode: .failedTrial)
    XCTAssertEqual(store.pointer?.active.artifactId, a)
    XCTAssertNil(store.pointer?.previous)
    XCTAssertTrue(store.knownBad().contains(b))
    XCTAssertFalse(store.releaseIsIntact(artifactId: b, bytes: 16))
  }

  func testRestoreWithoutPreviousIsInvalidState() throws {
    let store = try launch()
    try install(store, artifact: a)
    XCTAssertThrowsError(try store.restorePrevious(mode: .userSwap)) { error in
      XCTAssertEqual((error as? NamuError)?.code, "INVALID_STATE")
    }
  }

  // MARK: - Removal (SEC-006)

  func testRemovalIsRefusedWhileRuntimeHoldsReference() throws {
    let store = try launch()
    try install(store, artifact: a)
    store.runtimeReference = a
    XCTAssertThrowsError(try store.removeAllModels()) { XCTAssertEqual(($0 as? NamuError)?.code, "ENGINE_BUSY") }
    XCTAssertThrowsError(try store.deleteEverything()) { XCTAssertEqual(($0 as? NamuError)?.code, "ENGINE_BUSY") }
    XCTAssertEqual(store.installState, .installed)

    store.runtimeReference = nil
    try store.journal.recordAcceptedSequence(7, payloadSha256: TestSupport.sha("7"))
    try store.removeAllModels()
    XCTAssertEqual(store.installState, .absent)
    XCTAssertEqual(try store.journal.allTransfers().count, 0)
    XCTAssertEqual(store.journal.highestSequence, 7, "replay protection survives model removal")
    let relaunched = try launch()
    XCTAssertEqual(relaunched.installState, .absent)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: relaunched.releasesDirectory.path), [])
  }

  func testDeleteEverythingResetsToEmptyLayout() throws {
    let store = try launch()
    try install(store, artifact: a)
    try store.journal.markBad(sha256: b, reason: "x")
    try store.deleteEverything()
    XCTAssertEqual(store.installState, .absent)
    XCTAssertEqual(try store.journal.allTransfers().count, 0)
    XCTAssertEqual(store.knownBad(), [])
    XCTAssertFalse(FileManager.default.fileExists(atPath: store.pointerURL.path))
    XCTAssertNoThrow(try store.journal.insert(TestSupport.transfer(artifact: a, phase: .waiting)), "journal is usable again")
  }

  func testBundledKnownBadListIsMerged() throws {
    let store = try launch(knownBad: [a])
    try store.journal.markBad(sha256: b, reason: "x")
    XCTAssertEqual(store.knownBad(), [a, b])
  }
}
