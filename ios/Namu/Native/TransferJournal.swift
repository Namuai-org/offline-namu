import Foundation
import SQLite3

/// DL-015 transfer phases.
enum TransferPhase: String {
  case absent, waiting, downloading, paused, verifying, staged, selfTesting, installed, failed, removing

  /// Phases in which a transfer still owns network or verification work.
  var isInFlight: Bool {
    switch self {
    case .waiting, .downloading, .paused, .verifying: return true
    default: return false
    }
  }
}

/// One row of the `transfers` table (DL-002, contract §5). No chat data.
struct TransferRecord: Equatable {
  var transferId: String
  var descriptorSource: String
  var descriptorBytes: Data
  var descriptorHash: String
  var artifactVersion: String
  var artifactSha256: String
  var artifactPath: String
  var phase: TransferPhase
  var expectedBytes: Int64
  var committedBytes: Int64 = 0
  var verifiedBytes: Int64 = 0
  var etag: String?
  var stagedFilename: String?
  var osTaskId: String?
  var resumeData: Data?
  var meteredConsent = false
  var userPaused = false
  var restartedFromZero = false
  var retryCount = 0
  var nextRetryAt: Int64?
  var lastError: String?
  var createdAt: Int64
  var updatedAt: Int64
}

struct JournalError: Error, Equatable {
  let message: String
  let sqliteCode: Int32
}

/// Native transfer journal: SQLite, WAL, synchronous=FULL, owned only by the
/// transfer service (ARC-003). Authoritative for transfer progress; the active
/// pointer (ActivePointer.swift) is authoritative for activation.
final class TransferJournal {
  static let schemaVersion = "1"

  enum MetaKey {
    static let highestSequence = "highest_sequence"
    static let highestSequencePayloadSha256 = "highest_sequence_payload_sha256"
    static let activeMirror = "active_mirror"
    static let updateDescriptor = "update_descriptor"
    static let journalSchema = "journal_schema"
  }

  private var db: OpaquePointer?
  private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

  init(url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
    let code = sqlite3_open_v2(url.path, &db, flags, nil)
    guard code == SQLITE_OK else {
      sqlite3_close(db)
      db = nil
      throw JournalError(message: "open", sqliteCode: code)
    }
    sqlite3_busy_timeout(db, 5000)
    try exec("PRAGMA journal_mode=WAL")
    try exec("PRAGMA synchronous=FULL")
    // F_FULLFSYNC on commit: the journal must survive power loss (DL-012).
    try exec("PRAGMA fullfsync=ON")
    try exec("""
      CREATE TABLE IF NOT EXISTS transfers (
        transfer_id TEXT PRIMARY KEY,
        descriptor_source TEXT NOT NULL,
        descriptor_bytes BLOB NOT NULL,
        descriptor_hash TEXT NOT NULL,
        artifact_version TEXT NOT NULL,
        artifact_sha256 TEXT NOT NULL UNIQUE,
        artifact_path TEXT NOT NULL,
        phase TEXT NOT NULL,
        expected_bytes INTEGER NOT NULL,
        committed_bytes INTEGER NOT NULL DEFAULT 0,
        verified_bytes INTEGER NOT NULL DEFAULT 0,
        etag TEXT,
        staged_filename TEXT,
        os_task_id TEXT,
        resume_data BLOB,
        metered_consent INTEGER NOT NULL DEFAULT 0,
        user_paused INTEGER NOT NULL DEFAULT 0,
        restarted_from_zero INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bad_digests (sha256 TEXT PRIMARY KEY, reason TEXT NOT NULL, marked_at INTEGER NOT NULL);
      """)
    if try meta(MetaKey.journalSchema) == nil {
      try setMeta(MetaKey.journalSchema, TransferJournal.schemaVersion)
    }
  }

  deinit { close() }

  func close() {
    if let db { sqlite3_close_v2(db) }
    db = nil
  }

  // MARK: - Transfers

  /// DL-001: only one transfer per artifact. Returns the existing row when the
  /// artifact already has one; the check and insert share one transaction.
  @discardableResult
  func createOrGet(_ record: TransferRecord) throws -> (record: TransferRecord, created: Bool) {
    try exec("BEGIN IMMEDIATE")
    do {
      if let existing = try transfer(artifactSha256: record.artifactSha256) {
        try exec("COMMIT")
        return (existing, false)
      }
      try insert(record)
      try exec("COMMIT")
      return (record, true)
    } catch {
      try? exec("ROLLBACK")
      throw error
    }
  }

  func insert(_ r: TransferRecord) throws {
    let sql = """
      INSERT INTO transfers (transfer_id, descriptor_source, descriptor_bytes, descriptor_hash,
        artifact_version, artifact_sha256, artifact_path, phase, expected_bytes, committed_bytes,
        verified_bytes, etag, staged_filename, os_task_id, resume_data, metered_consent, user_paused,
        restarted_from_zero, retry_count, next_retry_at, last_error, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      """
    try run(sql) { stmt in bindAll(stmt, r) }
  }

  /// Full-row update keyed by transfer ID; bumps `updated_at`.
  func save(_ record: TransferRecord) throws {
    var r = record
    r.updatedAt = namuNowMs()
    let sql = """
      UPDATE transfers SET transfer_id=?, descriptor_source=?, descriptor_bytes=?, descriptor_hash=?,
        artifact_version=?, artifact_sha256=?, artifact_path=?, phase=?, expected_bytes=?,
        committed_bytes=?, verified_bytes=?, etag=?, staged_filename=?, os_task_id=?, resume_data=?,
        metered_consent=?, user_paused=?, restarted_from_zero=?, retry_count=?, next_retry_at=?,
        last_error=?, created_at=?, updated_at=? WHERE transfer_id=?
      """
    try run(sql) { stmt in
      bindAll(stmt, r)
      bind(stmt, 24, r.transferId)
    }
  }

  func transfer(id: String) throws -> TransferRecord? {
    try query("SELECT * FROM transfers WHERE transfer_id=?", bind: { self.bind($0, 1, id) }).first
  }

  func transfer(artifactSha256: String) throws -> TransferRecord? {
    try query("SELECT * FROM transfers WHERE artifact_sha256=?", bind: { self.bind($0, 1, artifactSha256) }).first
  }

  /// Newest first.
  func allTransfers() throws -> [TransferRecord] {
    try query("SELECT * FROM transfers ORDER BY created_at DESC, rowid DESC", bind: { _ in })
  }

  func deleteTransfer(id: String) throws {
    try run("DELETE FROM transfers WHERE transfer_id=?") { self.bind($0, 1, id) }
  }

  func deleteAllTransfers() throws {
    try exec("DELETE FROM transfers")
  }

  // MARK: - Meta

  func meta(_ key: String) throws -> String? {
    var value: String?
    try select("SELECT value FROM meta WHERE key=?", bind: { self.bind($0, 1, key) }, row: { stmt in
      value = TransferJournal.text(stmt, 0)
    })
    return value
  }

  func setMeta(_ key: String, _ value: String?) throws {
    if let value {
      try run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value") {
        self.bind($0, 1, key)
        self.bind($0, 2, value)
      }
    } else {
      try run("DELETE FROM meta WHERE key=?") { self.bind($0, 1, key) }
    }
  }

  var highestSequence: Int64 { Int64((try? meta(MetaKey.highestSequence)) ?? "") ?? 0 }
  var highestSequencePayloadSha256: String? { try? meta(MetaKey.highestSequencePayloadSha256) }

  /// SIG-003: persists `(sequence, payload hash)` only when the sequence grows.
  func recordAcceptedSequence(_ sequence: Int64, payloadSha256: String) throws {
    guard sequence > highestSequence else { return }
    try exec("BEGIN IMMEDIATE")
    do {
      try setMeta(MetaKey.highestSequence, String(sequence))
      try setMeta(MetaKey.highestSequencePayloadSha256, payloadSha256)
      try exec("COMMIT")
    } catch {
      try? exec("ROLLBACK")
      throw error
    }
  }

  // MARK: - Locally bad digests (DL-013)

  func markBad(sha256: String, reason: String) throws {
    try run("INSERT OR IGNORE INTO bad_digests (sha256, reason, marked_at) VALUES (?,?,?)") {
      self.bind($0, 1, sha256)
      self.bind($0, 2, reason)
      sqlite3_bind_int64($0, 3, namuNowMs())
    }
  }

  func badDigests() throws -> Set<String> {
    var out = Set<String>()
    try select("SELECT sha256 FROM bad_digests", bind: { _ in }, row: { stmt in
      if let value = TransferJournal.text(stmt, 0) { out.insert(value) }
    })
    return out
  }

  /// Diagnostic read of a PRAGMA (used by tests to assert WAL / FULL).
  func pragmaValue(_ name: String) -> String? {
    var value: String?
    try? select("PRAGMA \(name)", bind: { _ in }, row: { stmt in value = TransferJournal.text(stmt, 0) })
    return value
  }

  // MARK: - SQLite plumbing

  private func exec(_ sql: String) throws {
    var message: UnsafeMutablePointer<CChar>?
    let code = sqlite3_exec(db, sql, nil, nil, &message)
    sqlite3_free(message)
    guard code == SQLITE_OK else { throw JournalError(message: "exec", sqliteCode: code) }
  }

  private func select(_ sql: String, bind: (OpaquePointer) -> Void, row: ((OpaquePointer) -> Void)?) throws {
    var stmt: OpaquePointer?
    var code = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
    guard code == SQLITE_OK, let stmt else { throw JournalError(message: "prepare", sqliteCode: code) }
    defer { sqlite3_finalize(stmt) }
    bind(stmt)
    while true {
      code = sqlite3_step(stmt)
      if code == SQLITE_ROW { row?(stmt); continue }
      if code == SQLITE_DONE { return }
      throw JournalError(message: "step", sqliteCode: code)
    }
  }

  private func run(_ sql: String, _ bind: (OpaquePointer) -> Void) throws {
    try select(sql, bind: bind, row: nil)
  }

  private func query(_ sql: String, bind: (OpaquePointer) -> Void) throws -> [TransferRecord] {
    var rows = [TransferRecord]()
    try select(sql, bind: bind, row: { stmt in
      if let record = TransferJournal.record(from: stmt) { rows.append(record) }
    })
    return rows
  }

  private func bind(_ stmt: OpaquePointer, _ index: Int32, _ value: String?) {
    if let value {
      sqlite3_bind_text(stmt, index, value, -1, TransferJournal.transient)
    } else {
      sqlite3_bind_null(stmt, index)
    }
  }

  private func bind(_ stmt: OpaquePointer, _ index: Int32, _ value: Data?) {
    guard let value else { sqlite3_bind_null(stmt, index); return }
    if value.isEmpty {
      sqlite3_bind_zeroblob(stmt, index, 0)
    } else {
      value.withUnsafeBytes { raw in
        _ = sqlite3_bind_blob64(stmt, index, raw.baseAddress, sqlite3_uint64(value.count), TransferJournal.transient)
      }
    }
  }

  private func bindAll(_ stmt: OpaquePointer, _ r: TransferRecord) {
    bind(stmt, 1, r.transferId)
    bind(stmt, 2, r.descriptorSource)
    bind(stmt, 3, r.descriptorBytes)
    bind(stmt, 4, r.descriptorHash)
    bind(stmt, 5, r.artifactVersion)
    bind(stmt, 6, r.artifactSha256)
    bind(stmt, 7, r.artifactPath)
    bind(stmt, 8, r.phase.rawValue)
    sqlite3_bind_int64(stmt, 9, r.expectedBytes)
    sqlite3_bind_int64(stmt, 10, r.committedBytes)
    sqlite3_bind_int64(stmt, 11, r.verifiedBytes)
    bind(stmt, 12, r.etag)
    bind(stmt, 13, r.stagedFilename)
    bind(stmt, 14, r.osTaskId)
    bind(stmt, 15, r.resumeData)
    sqlite3_bind_int(stmt, 16, r.meteredConsent ? 1 : 0)
    sqlite3_bind_int(stmt, 17, r.userPaused ? 1 : 0)
    sqlite3_bind_int(stmt, 18, r.restartedFromZero ? 1 : 0)
    sqlite3_bind_int64(stmt, 19, Int64(r.retryCount))
    if let next = r.nextRetryAt { sqlite3_bind_int64(stmt, 20, next) } else { sqlite3_bind_null(stmt, 20) }
    bind(stmt, 21, r.lastError)
    sqlite3_bind_int64(stmt, 22, r.createdAt)
    sqlite3_bind_int64(stmt, 23, r.updatedAt)
  }

  private static func text(_ stmt: OpaquePointer, _ column: Int32) -> String? {
    guard sqlite3_column_type(stmt, column) != SQLITE_NULL, let raw = sqlite3_column_text(stmt, column) else {
      return nil
    }
    return String(cString: raw)
  }

  private static func blob(_ stmt: OpaquePointer, _ column: Int32) -> Data? {
    guard sqlite3_column_type(stmt, column) != SQLITE_NULL else { return nil }
    let count = Int(sqlite3_column_bytes(stmt, column))
    guard count > 0, let raw = sqlite3_column_blob(stmt, column) else { return Data() }
    return Data(bytes: raw, count: count)
  }

  private static func record(from stmt: OpaquePointer) -> TransferRecord? {
    guard let transferId = text(stmt, 0), let source = text(stmt, 1), let descriptor = blob(stmt, 2),
          let hash = text(stmt, 3), let version = text(stmt, 4), let sha = text(stmt, 5),
          let path = text(stmt, 6), let phaseText = text(stmt, 7),
          let phase = TransferPhase(rawValue: phaseText) else { return nil }
    return TransferRecord(
      transferId: transferId, descriptorSource: source, descriptorBytes: descriptor,
      descriptorHash: hash, artifactVersion: version, artifactSha256: sha, artifactPath: path,
      phase: phase, expectedBytes: sqlite3_column_int64(stmt, 8),
      committedBytes: sqlite3_column_int64(stmt, 9), verifiedBytes: sqlite3_column_int64(stmt, 10),
      etag: text(stmt, 11), stagedFilename: text(stmt, 12), osTaskId: text(stmt, 13),
      resumeData: blob(stmt, 14), meteredConsent: sqlite3_column_int(stmt, 15) != 0,
      userPaused: sqlite3_column_int(stmt, 16) != 0, restartedFromZero: sqlite3_column_int(stmt, 17) != 0,
      retryCount: Int(sqlite3_column_int64(stmt, 18)),
      nextRetryAt: sqlite3_column_type(stmt, 19) == SQLITE_NULL ? nil : sqlite3_column_int64(stmt, 19),
      lastError: text(stmt, 20), createdAt: sqlite3_column_int64(stmt, 21),
      updatedAt: sqlite3_column_int64(stmt, 22))
  }
}
