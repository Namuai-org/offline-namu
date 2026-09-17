import SQLite3
import XCTest
@testable import Namu

/// SEC-004 / SEC-005 / contract §7 against a small namu.sqlite fixture that
/// uses the chat schema from PRD §12.
final class ExportServiceTests: XCTestCase {
  private var directory: URL!
  private var dbDirectory: URL!
  private var service: ExportService!
  private var db: OpaquePointer?

  private let labelsJSON = """
    {"created":"Created","updated":"Updated","responseLanguage":"Response language",
     "languageNames":{"auto":"Same as my message","ha":"Hausa","fr":"Français","en":"English"},
     "you":"You","namu":"Namu","interrupted":"Answer interrupted","lengthLimited":"Length limit reached"}
    """

  private static let schema = """
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      title_is_custom INTEGER NOT NULL DEFAULT 0 CHECK(title_is_custom IN (0,1)),
      response_language TEXT NOT NULL DEFAULT 'auto'
        CHECK(response_language IN ('auto','ha','fr','en')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE turns (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      user_text TEXT NOT NULL,
      selected_attempt_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(conversation_id, ordinal)
    );
    CREATE TABLE assistant_attempts (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN
        ('pending','streaming','stopping','complete','stopped','interrupted','failed')),
      finish_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(turn_id, attempt_number)
    );
    CREATE TABLE generations (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL UNIQUE REFERENCES assistant_attempts(id) ON DELETE CASCADE,
      artifact_sha256 TEXT NOT NULL,
      runtime_build_id TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      parameters_json TEXT NOT NULL,
      prompt_tokens INTEGER,
      output_tokens INTEGER,
      error_code TEXT,
      started_at INTEGER,
      ended_at INTEGER
    );
    CREATE TABLE drafts (draft_key TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE preferences (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL);
    CREATE INDEX conversations_recent ON conversations(updated_at DESC, id DESC);
    CREATE INDEX turns_page ON turns(conversation_id, ordinal DESC);
    CREATE INDEX attempts_turn ON assistant_attempts(turn_id, attempt_number DESC);
    """

  override func setUpWithError() throws {
    directory = try TestSupport.makeTemporaryDirectory("export")
    dbDirectory = directory.appendingPathComponent("NamuData", isDirectory: true)
    try FileManager.default.createDirectory(at: dbDirectory, withIntermediateDirectories: true)
    XCTAssertEqual(sqlite3_open(dbDirectory.appendingPathComponent("namu.sqlite").path, &db), SQLITE_OK)
    try exec(ExportServiceTests.schema)
    service = ExportService(
      exportsDirectory: directory.appendingPathComponent("NamuExports", isDirectory: true),
      allowedDatabaseDirectory: dbDirectory)
  }

  override func tearDown() {
    sqlite3_close(db)
    db = nil
    TestSupport.remove(directory)
  }

  // MARK: - Fixture helpers

  private func exec(_ sql: String) throws {
    var message: UnsafeMutablePointer<CChar>?
    let code = sqlite3_exec(db, sql, nil, nil, &message)
    let text = message.map { String(cString: $0) } ?? ""
    sqlite3_free(message)
    if code != SQLITE_OK { throw NSError(domain: "fixture", code: Int(code), userInfo: [NSLocalizedDescriptionKey: text]) }
  }

  private func quote(_ text: String?) -> String {
    guard let text else { return "NULL" }
    return "'" + text.replacingOccurrences(of: "'", with: "''") + "'"
  }

  private func addConversation(_ id: String, title: String, language: String = "auto", created: Int64, updated: Int64) throws {
    try exec("INSERT INTO conversations (id,title,response_language,created_at,updated_at) VALUES (\(quote(id)),\(quote(title)),\(quote(language)),\(created),\(updated))")
  }

  /// Adds a turn; `attempts` are (content, status, finishReason, selected).
  private func addTurn(
    _ conversation: String, ordinal: Int, user: String,
    attempts: [(content: String, status: String, finish: String?, selected: Bool)] = []
  ) throws {
    let turnId = "\(conversation)-t\(ordinal)"
    try exec("INSERT INTO turns (id,conversation_id,ordinal,user_text,created_at) VALUES (\(quote(turnId)),\(quote(conversation)),\(ordinal),\(quote(user)),0)")
    for (index, attempt) in attempts.enumerated() {
      let attemptId = "\(turnId)-a\(index + 1)"
      try exec("INSERT INTO assistant_attempts (id,turn_id,attempt_number,content,status,finish_reason,created_at,updated_at) VALUES (\(quote(attemptId)),\(quote(turnId)),\(index + 1),\(quote(attempt.content)),\(quote(attempt.status)),\(quote(attempt.finish)),0,0)")
      if attempt.selected {
        try exec("UPDATE turns SET selected_attempt_id=\(quote(attemptId)) WHERE id=\(quote(turnId))")
      }
    }
  }

  private func seedMainConversation() throws {
    // 2026-09-17T12:00:00Z and one hour later
    try addConversation("c1", title: "Ƙwai: me ya sa?", language: "ha", created: 1_789_646_400_000, updated: 1_789_650_000_000)
    try addTurn("c1", ordinal: 1, user: "Sannu, ina son bayani game da ƙwai.\nLayi na biyu.", attempts: [
      ("Tsohon amsa", "complete", "eos", false),
      ("Ga bayani **mai sauƙi**.", "complete", "eos", true), // retry: only the selected attempt is exported
    ])
    try addTurn("c1", ordinal: 2, user: "Continue", attempts: [("Partial ans", "interrupted", nil, true)])
    try addTurn("c1", ordinal: 3, user: "Long one", attempts: [("Very long answer", "complete", "length", true)])
    try addTurn("c1", ordinal: 4, user: "Stopped and long", attempts: [("cut", "stopped", "length", true)])
    try addTurn("c1", ordinal: 5, user: "No answer yet")
  }

  private func read(_ exportId: String) throws -> (name: String, text: String) {
    let file = try XCTUnwrap(service.exportedFile(for: exportId))
    let data = try Data(contentsOf: file)
    XCTAssertNotEqual(Array(data.prefix(3)), [0xEF, 0xBB, 0xBF], "no BOM")
    return (file.lastPathComponent, String(decoding: data, as: UTF8.self))
  }

  // MARK: - Single conversation

  func testSingleConversationFormat() throws {
    try seedMainConversation()
    let exportId = try service.exportConversationSync(
      dbDirectory: dbDirectory.path, conversationId: "c1", labels: ExportLabels(json: labelsJSON))
    let (name, text) = try read(exportId)
    XCTAssertEqual(name, "Ƙwai_ me ya sa_.txt")
    XCTAssertEqual(text, """
      Ƙwai: me ya sa?
      Created: 2026-09-17T12:00:00Z
      Updated: 2026-09-17T13:00:00Z
      Response language: Hausa

      You:
      Sannu, ina son bayani game da ƙwai.
      Layi na biyu.

      Namu:
      Ga bayani **mai sauƙi**.

      You:
      Continue

      Namu:
      Partial ans
      [Answer interrupted]

      You:
      Long one

      Namu:
      Very long answer
      [Length limit reached]

      You:
      Stopped and long

      Namu:
      cut
      [Answer interrupted]
      [Length limit reached]

      You:
      No answer yet

      """)
    XCTAssertFalse(text.contains("\r"))
    XCTAssertFalse(text.contains("Tsohon amsa"), "unselected attempts are never exported")
  }

  func testTurnsStreamInOrdinalOrderAcrossPages() throws {
    try addConversation("big", title: "Big", created: 0, updated: 0)
    try exec("BEGIN")
    // Inserted out of order on purpose; more than two pages of 200.
    for ordinal in (1...450).reversed() {
      try addTurn("big", ordinal: ordinal, user: "question \(ordinal)", attempts: [("answer \(ordinal)", "complete", "eos", true)])
    }
    try exec("COMMIT")
    let exportId = try service.exportConversationSync(
      dbDirectory: dbDirectory.path, conversationId: "big", labels: ExportLabels(json: labelsJSON))
    let text = try read(exportId).text
    let questions = text.components(separatedBy: "\n").filter { $0.hasPrefix("question ") }
    XCTAssertEqual(questions, (1...450).map { "question \($0)" })
    XCTAssertEqual(text.components(separatedBy: "\n").filter { $0.hasPrefix("answer ") }.count, 450)
  }

  func testUnknownConversationLeavesNothingBehind() throws {
    try seedMainConversation()
    XCTAssertThrowsError(try service.exportConversationSync(
      dbDirectory: dbDirectory.path, conversationId: "missing", labels: ExportLabels(json: labelsJSON))
    ) { XCTAssertEqual(($0 as? NamuError)?.code, "NOT_FOUND") }
    let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: service.exportsDirectory.path)) ?? []
    XCTAssertEqual(leftovers, [], "T23: a failed export removes its partial output")
    // Source data is untouched and still writable.
    XCTAssertNoThrow(try addTurn("c1", ordinal: 6, user: "still writable"))
  }

  func testRejectsUnexpectedDatabaseDirectoryAndMissingDatabase() throws {
    XCTAssertThrowsError(try service.exportConversationSync(
      dbDirectory: directory.path, conversationId: "c1", labels: ExportLabels(json: labelsJSON))
    ) { XCTAssertEqual(($0 as? NamuError)?.code, "INVALID_STATE") }
    let empty = ExportService(exportsDirectory: service.exportsDirectory, allowedDatabaseDirectory: nil)
    XCTAssertThrowsError(try empty.exportConversationSync(
      dbDirectory: directory.appendingPathComponent("nowhere").path, conversationId: "c1", labels: ExportLabels(json: labelsJSON))
    ) { XCTAssertEqual(($0 as? NamuError)?.code, "DATABASE_RECOVERY") }
  }

  func testExportReadsAConsistentSnapshotWhileTheAppKeepsWriting() throws {
    try seedMainConversation()
    let snapshot = try ChatDatabaseSnapshot(file: dbDirectory.appendingPathComponent("namu.sqlite"))
    defer { snapshot.close() }
    // A write committed after the snapshot began is invisible to the export…
    try addTurn("c1", ordinal: 6, user: "written during export")
    XCTAssertEqual(try snapshot.turns(conversationId: "c1", after: nil, limit: 200).count, 5)
    // …and the writer was never blocked by the read transaction (WAL).
    let later = try ChatDatabaseSnapshot(file: dbDirectory.appendingPathComponent("namu.sqlite"))
    defer { later.close() }
    XCTAssertEqual(try later.turns(conversationId: "c1", after: nil, limit: 200).count, 6)
  }

  // MARK: - All conversations

  func testExportTreeAndIndex() throws {
    try seedMainConversation()
    try addConversation("c2", title: "../../etc/passwd", language: "fr", created: 1000, updated: 1_789_660_000_000)
    try addTurn("c2", ordinal: 1, user: "Bonjour", attempts: [("Salut", "complete", "eos", true)])
    try addConversation("c3", title: "   ", created: 2000, updated: 5000)

    let snapshot = try ChatDatabaseSnapshot(file: dbDirectory.appendingPathComponent("namu.sqlite"))
    defer { snapshot.close() }
    let tree = directory.appendingPathComponent("tree", isDirectory: true)
    try service.writeExportTree(
      database: snapshot, labels: ExportLabels(json: labelsJSON), tree: tree, now: Date(timeIntervalSince1970: 1_789_646_400))

    let index = try XCTUnwrap(try JSONSerialization.jsonObject(
      with: Data(contentsOf: tree.appendingPathComponent("index.json"))) as? [String: Any])
    XCTAssertEqual(index["export_schema"] as? Int, 1)
    XCTAssertEqual(index["exported_at"] as? String, "2026-09-17T12:00:00Z")
    XCTAssertNotNil(index["app_version"] as? String)
    let conversations = try XCTUnwrap(index["conversations"] as? [[String: Any]])
    // Newest first, numbered in listing order; titles never become paths.
    XCTAssertEqual(conversations.map { $0["id"] as? String }, ["c2", "c1", "c3"])
    XCTAssertEqual(conversations.map { $0["file"] as? String }, [
      "conversations/1-______etc_passwd.txt", "conversations/2-Ƙwai_ me ya sa_.txt", "conversations/3-conversation.txt",
    ])
    XCTAssertEqual(conversations.map { $0["turns"] as? Int }, [1, 5, 0])
    XCTAssertEqual(conversations[0]["title"] as? String, "../../etc/passwd")
    XCTAssertEqual(conversations[1]["created_at"] as? String, "2026-09-17T12:00:00Z")
    XCTAssertEqual(conversations[1]["updated_at"] as? String, "2026-09-17T13:00:00Z")
    for entry in conversations {
      let file = tree.appendingPathComponent(try XCTUnwrap(entry["file"] as? String))
      XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
      XCTAssertTrue(file.standardizedFileURL.path.hasPrefix(tree.standardizedFileURL.path + "/conversations/"))
    }
    let french = try String(contentsOf: tree.appendingPathComponent("conversations/1-______etc_passwd.txt"), encoding: .utf8)
    XCTAssertTrue(french.hasPrefix("../../etc/passwd\nCreated: 1970-01-01T00:00:01Z\n"))
    XCTAssertTrue(french.contains("Response language: Français\n\nYou:\nBonjour\n\nNamu:\nSalut\n"))
  }

  func testExportAllProducesOneZipAndCleansBuildDirectory() throws {
    try seedMainConversation()
    let exportId = try service.exportAllSync(
      dbDirectory: dbDirectory.path, labels: ExportLabels(json: labelsJSON), now: Date(timeIntervalSince1970: 1_789_646_400))
    let file = try XCTUnwrap(service.exportedFile(for: exportId))
    XCTAssertEqual(file.lastPathComponent, "namu-export-20260917-120000.zip")
    let data = try Data(contentsOf: file)
    XCTAssertEqual(Array(data.prefix(2)), Array("PK".utf8), "zip local file header")
    XCTAssertGreaterThan(data.count, 100)
    let contents = try FileManager.default.contentsOfDirectory(atPath: file.deletingLastPathComponent().path)
    XCTAssertEqual(contents, [file.lastPathComponent], "temporary tree is removed")
  }

  // MARK: - Housekeeping

  func testSweepRemovesOnlyExportsOlderThan24Hours() throws {
    try seedMainConversation()
    let labels = ExportLabels(json: labelsJSON)
    let old = try service.exportConversationSync(dbDirectory: dbDirectory.path, conversationId: "c1", labels: labels)
    let fresh = try service.exportConversationSync(dbDirectory: dbDirectory.path, conversationId: "c1", labels: labels)
    let oldDirectory = service.exportsDirectory.appendingPathComponent(old)
    try FileManager.default.setAttributes(
      [.modificationDate: Date(timeIntervalSinceNow: -25 * 3600)], ofItemAtPath: oldDirectory.path)

    XCTAssertEqual(service.sweepSync(now: Date()), 1)
    XCTAssertNil(service.exportedFile(for: old))
    XCTAssertNotNil(service.exportedFile(for: fresh))
    XCTAssertEqual(service.sweepSync(now: Date()), 0)
  }

  func testExportIdsAreNeverTreatedAsPaths() {
    XCTAssertNil(service.exportedFile(for: "../NamuData"))
    XCTAssertNil(service.exportedFile(for: ""))
    XCTAssertNil(service.exportedFile(for: UUID().uuidString.lowercased()), "unknown but well-formed")
  }

  func testSafeTitle() {
    XCTAssertEqual(ExportService.safeTitle("Hello, world! (v2)"), "Hello_ world_ _v2_")
    XCTAssertEqual(ExportService.safeTitle("ƙ ɗ ɓ é ñ 日本 123 -_"), "ƙ ɗ ɓ é ñ 日本 123 -_")
    XCTAssertEqual(ExportService.safeTitle("a/b\\c:d"), "a_b_c_d")
    XCTAssertEqual(ExportService.safeTitle(""), "conversation")
    XCTAssertEqual(ExportService.safeTitle("    "), "conversation")
    XCTAssertEqual(ExportService.safeTitle("😀"), "__", "one underscore per UTF-16 unit")
    XCTAssertEqual(ExportService.safeTitle(String(repeating: "x", count: 100)).utf16.count, 60)
    XCTAssertEqual(ExportService.safeTitle("line\nbreak"), "line_break")
  }

  func testLabelsFallBackToKeysAndStaySingleLine() {
    let labels = ExportLabels(json: "{\"you\":\"Kai\\nX\",\"languageNames\":{\"ha\":\"Hausa\"}}")
    XCTAssertEqual(labels.you, "Kai X")
    XCTAssertEqual(labels.namu, "namu")
    XCTAssertEqual(labels.languageNames["ha"], "Hausa")
    XCTAssertEqual(ExportLabels(json: "not json").created, "created")
  }
}
