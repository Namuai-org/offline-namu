import XCTest
@testable import Namu

/// DL-001 / DL-002 / contract §5.
final class TransferJournalTests: XCTestCase {
  private var directory: URL!
  private var journal: TransferJournal!

  override func setUpWithError() throws {
    directory = try TestSupport.makeTemporaryDirectory("journal")
    journal = try TransferJournal(url: directory.appendingPathComponent("journal/transfer-journal.sqlite"))
  }

  override func tearDown() {
    journal.close()
    TestSupport.remove(directory)
  }

  func testUsesWalAndFullSynchronous() {
    XCTAssertEqual(journal.pragmaValue("journal_mode"), "wal")
    XCTAssertEqual(journal.pragmaValue("synchronous"), "2") // FULL
    XCTAssertEqual(try journal.meta(TransferJournal.MetaKey.journalSchema), "1")
  }

  func testStartIsIdempotentPerArtifact() throws {
    let artifact = TestSupport.sha("a")
    let first = try journal.createOrGet(TestSupport.transfer(artifact: artifact, phase: .waiting))
    XCTAssertTrue(first.created)
    // A second start for the same artifact returns the existing transfer ID.
    let second = try journal.createOrGet(TestSupport.transfer(artifact: artifact, phase: .waiting))
    XCTAssertFalse(second.created)
    XCTAssertEqual(second.record.transferId, first.record.transferId)
    XCTAssertEqual(try journal.allTransfers().count, 1)
  }

  func testSchemaRefusesSecondTransferForSameArtifact() throws {
    let artifact = TestSupport.sha("a")
    try journal.insert(TestSupport.transfer(artifact: artifact, phase: .waiting))
    XCTAssertThrowsError(try journal.insert(TestSupport.transfer(artifact: artifact, phase: .waiting))) { error in
      XCTAssertEqual((error as? JournalError)?.sqliteCode, 19) // SQLITE_CONSTRAINT
    }
    // A different artifact is a different transfer.
    XCTAssertNoThrow(try journal.insert(TestSupport.transfer(artifact: TestSupport.sha("b"), phase: .waiting)))
    XCTAssertEqual(try journal.allTransfers().count, 2)
  }

  func testRoundTripsEveryColumn() throws {
    var record = TestSupport.transfer(artifact: TestSupport.sha("c"), phase: .downloading, bytes: 2_143_977_056)
    record.descriptorSource = "update"
    record.descriptorBytes = Data([0, 1, 2, 0xff])
    record.committedBytes = 1_000_000_007
    record.verifiedBytes = 5
    record.etag = "\"abc\""
    record.stagedFilename = "x.download"
    record.osTaskId = "42"
    record.resumeData = Data(repeating: 7, count: 70_000) // opaque blob, stored verbatim
    record.meteredConsent = true
    record.userPaused = true
    record.restartedFromZero = true
    record.retryCount = 3
    record.nextRetryAt = 1_789_646_400_000
    record.lastError = "NETWORK_WAIT"
    try journal.insert(record)
    XCTAssertEqual(try journal.transfer(id: record.transferId), record)

    record.resumeData = nil
    record.nextRetryAt = nil
    record.lastError = nil
    record.phase = .paused
    try journal.save(record)
    let loaded = try XCTUnwrap(try journal.transfer(artifactSha256: record.artifactSha256))
    XCTAssertNil(loaded.resumeData)
    XCTAssertNil(loaded.nextRetryAt)
    XCTAssertNil(loaded.lastError)
    XCTAssertEqual(loaded.phase, .paused)
    XCTAssertGreaterThanOrEqual(loaded.updatedAt, record.updatedAt)
  }

  func testSurvivesReopen() throws {
    let record = TestSupport.transfer(artifact: TestSupport.sha("d"), phase: .paused)
    try journal.insert(record)
    try journal.markBad(sha256: TestSupport.sha("e"), reason: "test")
    journal.close()
    journal = try TransferJournal(url: directory.appendingPathComponent("journal/transfer-journal.sqlite"))
    XCTAssertEqual(try journal.transfer(id: record.transferId)?.phase, .paused)
    XCTAssertEqual(try journal.badDigests(), [TestSupport.sha("e")])
  }

  func testNewestTransferFirstAndDelete() throws {
    let old = TestSupport.transfer(artifact: TestSupport.sha("a"), phase: .installed, createdAt: 1000)
    let new = TestSupport.transfer(artifact: TestSupport.sha("b"), phase: .downloading, createdAt: 2000)
    try journal.insert(old)
    try journal.insert(new)
    XCTAssertEqual(try journal.allTransfers().map(\.transferId), [new.transferId, old.transferId])
    try journal.deleteTransfer(id: new.transferId)
    XCTAssertEqual(try journal.allTransfers().map(\.transferId), [old.transferId])
  }

  /// SIG-003: the stored sequence only grows.
  func testHighestSequenceIsMonotonic() throws {
    XCTAssertEqual(journal.highestSequence, 0)
    XCTAssertNil(journal.highestSequencePayloadSha256)
    try journal.recordAcceptedSequence(6, payloadSha256: TestSupport.sha("1"))
    try journal.recordAcceptedSequence(4, payloadSha256: TestSupport.sha("2"))
    try journal.recordAcceptedSequence(6, payloadSha256: TestSupport.sha("3"))
    XCTAssertEqual(journal.highestSequence, 6)
    XCTAssertEqual(journal.highestSequencePayloadSha256, TestSupport.sha("1"))
    try journal.recordAcceptedSequence(9, payloadSha256: TestSupport.sha("4"))
    XCTAssertEqual(journal.highestSequence, 9)
    XCTAssertEqual(journal.highestSequencePayloadSha256, TestSupport.sha("4"))
  }

  func testMetaSetReplaceAndClear() throws {
    try journal.setMeta("k", "1")
    try journal.setMeta("k", "2")
    XCTAssertEqual(try journal.meta("k"), "2")
    try journal.setMeta("k", nil)
    XCTAssertNil(try journal.meta("k"))
  }
}
