import Foundation
import SQLite3
import UIKit

/// Localized labels supplied by JS so native code carries no string tables.
struct ExportLabels {
  var created = "created"
  var updated = "updated"
  var responseLanguage = "responseLanguage"
  var languageNames = [String: String]()
  var you = "you"
  var namu = "namu"
  var interrupted = "interrupted"
  var lengthLimited = "lengthLimited"

  init(json: String) {
    guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return }
    func text(_ key: String, _ fallback: String) -> String {
      guard let value = object[key] as? String, !value.isEmpty else { return fallback }
      return value.replacingOccurrences(of: "\n", with: " ")
    }
    created = text("created", created)
    updated = text("updated", updated)
    responseLanguage = text("responseLanguage", responseLanguage)
    you = text("you", you)
    namu = text("namu", namu)
    interrupted = text("interrupted", interrupted)
    lengthLimited = text("lengthLimited", lengthLimited)
    languageNames = (object["languageNames"] as? [String: String]) ?? [:]
  }
}

/// Streaming text export (SEC-004, SEC-005, contract §7). Reads namu.sqlite
/// through its own read-only connection inside ONE read transaction (a
/// consistent WAL snapshot) and streams rows to disk through a FileHandle; the
/// history is never assembled in memory. Chat text is never logged.
final class ExportService {
  static let shared = ExportService(
    exportsDirectory: ExportService.defaultExportsDirectory(),
    allowedDatabaseDirectory: PlatformService.chatDataDirectoryURL())

  static let pageSize = 200
  static let maxAge: TimeInterval = 24 * 3600
  private static let spaceMargin: Int64 = 32 * NamuConstants.mib

  let exportsDirectory: URL
  private let allowedDatabaseDirectory: URL?
  private let queue = DispatchQueue(label: "org.namuai.offline.export", qos: .userInitiated)
  private let fm = FileManager.default

  /// - Parameter allowedDatabaseDirectory: when set, `dbDirectory` arguments
  ///   must resolve to exactly this directory; JS never chooses other paths.
  init(exportsDirectory: URL, allowedDatabaseDirectory: URL?) {
    self.exportsDirectory = exportsDirectory
    self.allowedDatabaseDirectory = allowedDatabaseDirectory
  }

  static func defaultExportsDirectory() -> URL {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("NamuExports", isDirectory: true)
  }

  // MARK: - Public API (asynchronous wrappers)

  func exportConversation(
    dbDirectory: String, conversationId: String, labelsJSON: String,
    completion: @escaping (Result<String, NamuError>) -> Void
  ) {
    queue.async {
      completion(Result { try self.exportConversationSync(
        dbDirectory: dbDirectory, conversationId: conversationId, labels: ExportLabels(json: labelsJSON))
      }.mapError { NamuError.wrap($0, fallback: NamuError.storageWriteFailed) })
    }
  }

  func exportAllConversations(
    dbDirectory: String, labelsJSON: String, completion: @escaping (Result<String, NamuError>) -> Void
  ) {
    queue.async {
      completion(Result { try self.exportAllSync(dbDirectory: dbDirectory, labels: ExportLabels(json: labelsJSON)) }
        .mapError { NamuError.wrap($0, fallback: NamuError.storageWriteFailed) })
    }
  }

  func deleteExport(_ exportId: String, completion: @escaping (Result<Void, NamuError>) -> Void) {
    queue.async {
      guard let directory = self.directory(for: exportId) else {
        completion(.failure(NamuError(NamuError.notFound, "export")))
        return
      }
      try? self.fm.removeItem(at: directory) // idempotent
      completion(.success(()))
    }
  }

  func sweepExports(completion: @escaping (Result<Int, NamuError>) -> Void) {
    queue.async { completion(.success(self.sweepSync(now: Date()))) }
  }

  func deleteAllExports(completion: @escaping (Result<Void, NamuError>) -> Void) {
    queue.async {
      try? self.fm.removeItem(at: self.exportsDirectory)
      completion(.success(()))
    }
  }

  /// Presents the system share sheet only after the file is complete.
  /// Resolves true when the user completed an activity.
  func share(_ exportId: String, completion: @escaping (Result<Bool, NamuError>) -> Void) {
    queue.async {
      guard let file = self.exportedFile(for: exportId) else {
        completion(.failure(NamuError(NamuError.notFound, "export")))
        return
      }
      DispatchQueue.main.async {
        guard let presenter = ExportService.topViewController() else {
          completion(.failure(NamuError(NamuError.invalidState, "no presenter")))
          return
        }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        if let popover = sheet.popoverPresentationController { // iPad
          popover.sourceView = presenter.view
          popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
          popover.permittedArrowDirections = []
        }
        sheet.completionWithItemsHandler = { _, completed, _, _ in
          if completed {
            // SEC-005: remove the temporary export once it has been handed over.
            self.queue.async { if let dir = self.directory(for: exportId) { try? self.fm.removeItem(at: dir) } }
          }
          completion(.success(completed))
        }
        presenter.present(sheet, animated: true)
      }
    }
  }

  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.flatMap(\.windows).first
    var top = window?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }

  // MARK: - Synchronous core (unit-tested)

  func exportConversationSync(dbDirectory: String, conversationId: String, labels: ExportLabels) throws -> String {
    let database = try openSnapshot(dbDirectory: dbDirectory)
    defer { database.close() }
    let (exportId, directory) = try makeExportDirectory()
    do {
      guard let conversation = try database.conversation(id: conversationId) else {
        throw NamuError(NamuError.notFound, "conversation")
      }
      let file = directory.appendingPathComponent(ExportService.safeTitle(conversation.title) + ".txt")
      _ = try writeConversation(conversation, database: database, labels: labels, to: file)
      return exportId
    } catch {
      try? fm.removeItem(at: directory) // T23: no partial export is left behind
      throw error
    }
  }

  func exportAllSync(dbDirectory: String, labels: ExportLabels, now: Date = Date()) throws -> String {
    let database = try openSnapshot(dbDirectory: dbDirectory)
    defer { database.close() }
    let (exportId, directory) = try makeExportDirectory()
    do {
      let stamp = ExportService.fileStamp(now)
      let tree = directory.appendingPathComponent("build/namu-export-\(stamp)", isDirectory: true)
      try writeExportTree(database: database, labels: labels, tree: tree, now: now)
      let zip = directory.appendingPathComponent("namu-export-\(stamp).zip")
      try ExportService.zipDirectory(tree, to: zip)
      try fm.removeItem(at: directory.appendingPathComponent("build"))
      return exportId
    } catch {
      try? fm.removeItem(at: directory)
      throw error
    }
  }

  /// Writes `conversations/<n>-<safe-title>.txt` and a streamed `index.json`
  /// (export schema 1) under `tree`, all from the one open snapshot.
  func writeExportTree(database: ChatDatabaseSnapshot, labels: ExportLabels, tree: URL, now: Date) throws {
    let conversationsDirectory = tree.appendingPathComponent("conversations", isDirectory: true)
    try fm.createDirectory(at: conversationsDirectory, withIntermediateDirectories: true)

    // index.json is streamed too: one fragment per conversation.
    let index = try StreamWriter(url: tree.appendingPathComponent("index.json"))
    do {
      let head: [String: Any] = [
        "export_schema": 1, "exported_at": ExportService.iso8601(ms: Int64(now.timeIntervalSince1970 * 1000)),
        "app_version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
      ]
      let headJSON = String(decoding: try JSONSerialization.data(withJSONObject: head, options: [.sortedKeys]), as: UTF8.self)
      try index.write(String(headJSON.dropLast()) + ",\"conversations\":[")

      var number = 0
      var cursor: (updatedAt: Int64, id: String)?
      while true {
        let page = try database.conversations(after: cursor, limit: ExportService.pageSize)
        for conversation in page {
          number += 1
          let relative = "conversations/\(number)-\(ExportService.safeTitle(conversation.title)).txt"
          let turns = try writeConversation(
            conversation, database: database, labels: labels, to: tree.appendingPathComponent(relative))
          let entry: [String: Any] = [
            "id": conversation.id, "title": conversation.title, "file": relative,
            "created_at": ExportService.iso8601(ms: conversation.createdAt),
            "updated_at": ExportService.iso8601(ms: conversation.updatedAt), "turns": turns,
          ]
          let entryJSON = try JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys])
          try index.write((number > 1 ? "," : "") + String(decoding: entryJSON, as: UTF8.self))
        }
        guard let last = page.last, page.count == ExportService.pageSize else { break }
        cursor = (last.updatedAt, last.id)
      }
      try index.write("]}\n")
      try index.close()
    } catch {
      try? index.close()
      throw error
    }
  }

  /// SEC-005: removes leftovers older than 24 hours; returns how many.
  @discardableResult
  func sweepSync(now: Date) -> Int {
    var removed = 0
    let keys: [URLResourceKey] = [.contentModificationDateKey]
    for item in (try? fm.contentsOfDirectory(at: exportsDirectory, includingPropertiesForKeys: keys)) ?? [] {
      let modified = (try? item.resourceValues(forKeys: Set(keys)))?.contentModificationDate ?? .distantPast
      if now.timeIntervalSince(modified) > ExportService.maxAge, (try? fm.removeItem(at: item)) != nil {
        removed += 1
      }
    }
    return removed
  }

  func exportedFile(for exportId: String) -> URL? {
    guard let directory = directory(for: exportId),
          let items = try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return nil }
    return items.first { ["txt", "zip"].contains($0.pathExtension) }
  }

  // MARK: - Helpers

  private func directory(for exportId: String) -> URL? {
    // Export IDs are app-generated UUIDs; nothing else ever becomes a path.
    guard NamuPattern.isUUID(exportId) else { return nil }
    return exportsDirectory.appendingPathComponent(exportId, isDirectory: true)
  }

  private func makeExportDirectory() throws -> (String, URL) {
    try fm.createDirectory(at: exportsDirectory, withIntermediateDirectories: true)
    var root = exportsDirectory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true // SEC-001
    try? root.setResourceValues(values)
    try? fm.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: exportsDirectory.path)
    let exportId = UUID().uuidString.lowercased()
    let directory = exportsDirectory.appendingPathComponent(exportId, isDirectory: true)
    try fm.createDirectory(at: directory, withIntermediateDirectories: false)
    return (exportId, directory)
  }

  private func openSnapshot(dbDirectory: String) throws -> ChatDatabaseSnapshot {
    let directory = URL(fileURLWithPath: dbDirectory, isDirectory: true).standardizedFileURL
    if let allowed = allowedDatabaseDirectory, allowed.standardizedFileURL.path != directory.path {
      throw NamuError(NamuError.invalidState, "unexpected database directory")
    }
    let file = directory.appendingPathComponent("namu.sqlite")
    guard fm.fileExists(atPath: file.path) else { throw NamuError(NamuError.databaseRecovery, "database missing") }
    // Low space fails before anything is written (T23).
    let size = ((try? fm.attributesOfItem(atPath: file.path))?[.size] as? NSNumber)?.int64Value ?? 0
    let volume = try? exportsDirectory.deletingLastPathComponent()
      .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    if let free = volume?.volumeAvailableCapacityForImportantUsage, free > 0,
       free < size * 2 + ExportService.spaceMargin {
      throw NamuError(NamuError.spaceLow, "insufficient space for export")
    }
    return try ChatDatabaseSnapshot(file: file)
  }

  /// Streams one conversation; returns the number of turns written.
  private func writeConversation(
    _ conversation: ChatDatabaseSnapshot.Conversation, database: ChatDatabaseSnapshot, labels: ExportLabels,
    to file: URL
  ) throws -> Int {
    let writer = try StreamWriter(url: file)
    do {
      let language = labels.languageNames[conversation.responseLanguage] ?? conversation.responseLanguage
      try writer.write(ExportService.singleLine(conversation.title) + "\n")
      try writer.write("\(labels.created): \(ExportService.iso8601(ms: conversation.createdAt))\n")
      try writer.write("\(labels.updated): \(ExportService.iso8601(ms: conversation.updatedAt))\n")
      try writer.write("\(labels.responseLanguage): \(language)\n")

      var turns = 0
      var lastOrdinal: Int64?
      while true {
        let page = try database.turns(conversationId: conversation.id, after: lastOrdinal, limit: ExportService.pageSize)
        for turn in page {
          turns += 1
          try writer.write("\n\(labels.you):\n\(turn.userText)\n")
          // Only the selected attempt is exported (CHAT-004).
          if let content = turn.selectedContent {
            try writer.write("\n\(labels.namu):\n\(content)\n")
            if ["interrupted", "stopped", "failed"].contains(turn.selectedStatus ?? "") {
              try writer.write("[\(labels.interrupted)]\n")
            }
            if turn.finishReason == "length" { try writer.write("[\(labels.lengthLimited)]\n") }
          }
        }
        guard let last = page.last, page.count == ExportService.pageSize else { break }
        lastOrdinal = last.ordinal
      }
      try writer.close()
      return turns
    } catch {
      try? writer.close()
      throw error
    }
  }

  /// Title with every character outside letters/digits/space/`-_` replaced by
  /// `_`, cut to 60 UTF-16 units; fallback `conversation`.
  static func safeTitle(_ title: String) -> String {
    var out = ""
    for scalar in title.unicodeScalars {
      if scalar.value > 0xFFFF {
        out += "__" // one per UTF-16 unit, like the Android implementation
        continue
      }
      let isLetterOrDigit: Bool
      switch scalar.properties.generalCategory {
      case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter, .decimalNumber:
        isLetterOrDigit = true
      default:
        isLetterOrDigit = false
      }
      out.unicodeScalars.append(isLetterOrDigit || scalar == " " || scalar == "-" || scalar == "_" ? scalar : "_")
    }
    let cut = String(decoding: Array(out.utf16.prefix(60)), as: UTF16.self)
    let trimmed = cut.trimmingCharacters(in: .whitespaces)
    return trimmed.isEmpty ? "conversation" : trimmed
  }

  static func singleLine(_ text: String) -> String {
    text.components(separatedBy: .newlines).joined(separator: " ")
  }

  static func iso8601(ms: Int64) -> String {
    DescriptorVerifier.formatTimestamp(ms: ms)
  }

  static func fileStamp(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyyMMdd-HHmmss"
    return formatter.string(from: date)
  }

  /// ZIP through the system: a coordinated read `.forUploading` of a directory
  /// hands back a temporary zip archive of it.
  static func zipDirectory(_ directory: URL, to destination: URL) throws {
    var coordinationError: NSError?
    var copyError: Error?
    NSFileCoordinator().coordinate(readingItemAt: directory, options: [.forUploading], error: &coordinationError) { zipped in
      do {
        try FileManager.default.copyItem(at: zipped, to: destination)
      } catch {
        copyError = error
      }
    }
    if coordinationError != nil || copyError != nil {
      throw NamuError(NamuError.storageWriteFailed, "zip failed")
    }
  }
}

/// Append-only UTF-8 writer (no BOM, `\n` newlines) over a FileHandle.
private final class StreamWriter {
  private let handle: FileHandle

  init(url: URL) throws {
    guard FileManager.default.createFile(
      atPath: url.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete]) else {
      throw NamuError(NamuError.storageWriteFailed, "create export file")
    }
    do {
      handle = try FileHandle(forWritingTo: url)
    } catch {
      throw NamuError(NamuError.storageWriteFailed, "open export file")
    }
  }

  func write(_ text: String) throws {
    do {
      try handle.write(contentsOf: Data(text.utf8))
    } catch {
      throw NamuError(NamuError.storageWriteFailed, "write export file")
    }
  }

  func close() throws {
    try? handle.synchronize()
    try handle.close()
  }
}

/// Read-only connection to namu.sqlite holding one read transaction open for
/// its whole lifetime (consistent snapshot; never a naive file copy, DB-006).
final class ChatDatabaseSnapshot {
  struct Conversation {
    let id: String
    let title: String
    let responseLanguage: String
    let createdAt: Int64
    let updatedAt: Int64
  }

  struct Turn {
    let ordinal: Int64
    let userText: String
    let selectedContent: String?
    let selectedStatus: String?
    let finishReason: String?
  }

  private var db: OpaquePointer?
  private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

  init(file: URL) throws {
    guard sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
      sqlite3_close(db)
      db = nil
      throw NamuError(NamuError.databaseRecovery, "open")
    }
    sqlite3_busy_timeout(db, 5000)
    // The first read inside the transaction pins the WAL snapshot.
    guard sqlite3_exec(db, "BEGIN", nil, nil, nil) == SQLITE_OK,
          sqlite3_exec(db, "SELECT count(*) FROM conversations", nil, nil, nil) == SQLITE_OK else {
      close()
      throw NamuError(NamuError.databaseRecovery, "snapshot")
    }
  }

  deinit { close() }

  func close() {
    guard let db else { return }
    sqlite3_exec(db, "COMMIT", nil, nil, nil)
    sqlite3_close_v2(db)
    self.db = nil
  }

  func conversation(id: String) throws -> Conversation? {
    try rows(
      "SELECT id, title, response_language, created_at, updated_at FROM conversations WHERE id = ?",
      bind: { self.bind($0, 1, id) }, map: ChatDatabaseSnapshot.conversation).first
  }

  /// Keyset pages, newest first (DB-004 ordering).
  func conversations(after cursor: (updatedAt: Int64, id: String)?, limit: Int) throws -> [Conversation] {
    if let cursor {
      return try rows(
        """
        SELECT id, title, response_language, created_at, updated_at FROM conversations
        WHERE updated_at < ? OR (updated_at = ? AND id < ?) ORDER BY updated_at DESC, id DESC LIMIT ?
        """,
        bind: {
          sqlite3_bind_int64($0, 1, cursor.updatedAt)
          sqlite3_bind_int64($0, 2, cursor.updatedAt)
          self.bind($0, 3, cursor.id)
          sqlite3_bind_int64($0, 4, Int64(limit))
        }, map: ChatDatabaseSnapshot.conversation)
    }
    return try rows(
      "SELECT id, title, response_language, created_at, updated_at FROM conversations ORDER BY updated_at DESC, id DESC LIMIT ?",
      bind: { sqlite3_bind_int64($0, 1, Int64(limit)) }, map: ChatDatabaseSnapshot.conversation)
  }

  func turns(conversationId: String, after ordinal: Int64?, limit: Int) throws -> [Turn] {
    try rows(
      """
      SELECT t.ordinal, t.user_text, a.content, a.status, a.finish_reason
      FROM turns t LEFT JOIN assistant_attempts a ON a.id = t.selected_attempt_id AND a.turn_id = t.id
      WHERE t.conversation_id = ? AND t.ordinal > ? ORDER BY t.ordinal ASC LIMIT ?
      """,
      bind: {
        self.bind($0, 1, conversationId)
        sqlite3_bind_int64($0, 2, ordinal ?? Int64.min)
        sqlite3_bind_int64($0, 3, Int64(limit))
      },
      map: { stmt in
        Turn(
          ordinal: sqlite3_column_int64(stmt, 0), userText: ChatDatabaseSnapshot.text(stmt, 1) ?? "",
          selectedContent: ChatDatabaseSnapshot.text(stmt, 2), selectedStatus: ChatDatabaseSnapshot.text(stmt, 3),
          finishReason: ChatDatabaseSnapshot.text(stmt, 4))
      })
  }

  private static func conversation(_ stmt: OpaquePointer) -> Conversation {
    Conversation(
      id: text(stmt, 0) ?? "", title: text(stmt, 1) ?? "", responseLanguage: text(stmt, 2) ?? "auto",
      createdAt: sqlite3_column_int64(stmt, 3), updatedAt: sqlite3_column_int64(stmt, 4))
  }

  private func bind(_ stmt: OpaquePointer, _ index: Int32, _ value: String) {
    sqlite3_bind_text(stmt, index, value, -1, ChatDatabaseSnapshot.transient)
  }

  private static func text(_ stmt: OpaquePointer, _ column: Int32) -> String? {
    guard sqlite3_column_type(stmt, column) != SQLITE_NULL, let raw = sqlite3_column_text(stmt, column) else {
      return nil
    }
    return String(cString: raw)
  }

  private func rows<T>(_ sql: String, bind: (OpaquePointer) -> Void, map: (OpaquePointer) -> T) throws -> [T] {
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
      throw NamuError(NamuError.databaseRecovery, "prepare")
    }
    defer { sqlite3_finalize(stmt) }
    bind(stmt)
    var out = [T]()
    while true {
      let code = sqlite3_step(stmt)
      if code == SQLITE_ROW { out.append(map(stmt)); continue }
      if code == SQLITE_DONE { return out }
      throw NamuError(NamuError.databaseRecovery, "step")
    }
  }
}
