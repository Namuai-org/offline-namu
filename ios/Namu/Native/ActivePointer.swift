import Foundation

/// One installed artifact as recorded in `active.json` (contract §6.4).
struct ActiveEntry: Codable, Equatable {
  var artifactId: String
  var version: String
  var bytes: Int64
  var sha256: String
  var activatedAt: Int64

  var isStructurallyValid: Bool {
    NamuPattern.isSha256Hex(artifactId) && sha256 == artifactId && bytes > 0
      && DescriptorVerifier.isArtifactVersion(version)
  }
}

struct TrialState: Codable, Equatable {
  var startedAt: Int64
  var successfulSessions: Int
}

/// `active.json`: the activation authority (DL-012).
struct ActivePointer: Codable, Equatable {
  var schema: Int = 1
  var active: ActiveEntry
  var previous: ActiveEntry?
  var trial: TrialState

  var isStructurallyValid: Bool {
    schema == 1 && active.isStructurallyValid && (previous?.isStructurallyValid ?? true)
      && previous?.artifactId != active.artifactId && trial.successfulSessions >= 0
  }

  func encoded() throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return try encoder.encode(self)
  }
}

/// Durable small-file primitives used for `active.json` and
/// `pending-activation.json`: write temp → F_FULLFSYNC → rename → fsync dir.
/// `crashHook` lets tests abandon the sequence at every checkpoint (T10).
enum DurableFile {
  enum Checkpoint: String, CaseIterable {
    case beforeTempWrite
    case tempPartiallyWritten
    case tempWritten
    case tempSynced
    case renamed
    case directorySynced
  }

  struct SimulatedCrash: Error, Equatable {
    let checkpoint: Checkpoint
  }

  struct IOFailure: Error {
    let operation: String
    let code: Int32
  }

  /// Test-only crash injection. Throwing from the hook abandons the write at
  /// that checkpoint, leaving the file system exactly as a crash would.
  static var crashHook: ((Checkpoint, URL) throws -> Void)?

  static func tempURL(for url: URL) -> URL {
    url.deletingLastPathComponent().appendingPathComponent(url.lastPathComponent + ".tmp")
  }

  static func write(_ data: Data, to url: URL) throws {
    let temp = tempURL(for: url)
    try crashHook?(.beforeTempWrite, url)

    let fd = open(temp.path, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
    guard fd >= 0 else { throw IOFailure(operation: "open", code: errno) }
    var closed = false
    defer { if !closed { close(fd) } }

    // A torn temp file must never be mistaken for a pointer: write the first
    // half, give the hook a chance to "crash", then write the rest.
    let half = data.count / 2
    try writeAll(fd, data.prefix(half))
    try crashHook?(.tempPartiallyWritten, url)
    try writeAll(fd, data.suffix(from: data.startIndex + half))
    try crashHook?(.tempWritten, url)

    try fullSync(fd)
    closed = true
    guard close(fd) == 0 else { throw IOFailure(operation: "close", code: errno) }
    try crashHook?(.tempSynced, url)

    // rename(2) atomically replaces the destination on the same volume.
    guard rename(temp.path, url.path) == 0 else { throw IOFailure(operation: "rename", code: errno) }
    try crashHook?(.renamed, url)

    try syncDirectory(url.deletingLastPathComponent())
    try crashHook?(.directorySynced, url)
  }

  /// Durable unlink: remove, then fsync the directory entry change.
  static func remove(_ url: URL) throws {
    if unlink(url.path) != 0 && errno != ENOENT { throw IOFailure(operation: "unlink", code: errno) }
    try syncDirectory(url.deletingLastPathComponent())
  }

  static func syncDirectory(_ directory: URL) throws {
    let fd = open(directory.path, O_RDONLY)
    guard fd >= 0 else { throw IOFailure(operation: "open-dir", code: errno) }
    defer { close(fd) }
    // F_FULLFSYNC is not supported on every directory descriptor; fsync is the
    // portable floor.
    if fcntl(fd, F_FULLFSYNC) != 0 {
      guard fsync(fd) == 0 else { throw IOFailure(operation: "fsync-dir", code: errno) }
    }
  }

  private static func fullSync(_ fd: Int32) throws {
    if fcntl(fd, F_FULLFSYNC) != 0 {
      guard fsync(fd) == 0 else { throw IOFailure(operation: "fsync", code: errno) }
    }
  }

  private static func writeAll(_ fd: Int32, _ data: Data) throws {
    try data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      var offset = 0
      while offset < raw.count {
        let written = Darwin.write(fd, raw.baseAddress! + offset, raw.count - offset)
        if written < 0 {
          if errno == EINTR { continue }
          throw IOFailure(operation: "write", code: errno)
        }
        offset += written
      }
    }
  }
}

/// Reads and durably replaces `active.json`.
struct ActivePointerStore {
  let url: URL
  static let maxBytes = 64 * 1024

  /// Returns nil when the pointer is missing or corrupt. A leftover `.tmp` is
  /// never promoted (contract §6.4); it is simply removed.
  func load() -> ActivePointer? {
    try? FileManager.default.removeItem(at: DurableFile.tempURL(for: url))
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
          let size = attributes[.size] as? NSNumber, size.intValue > 0,
          size.intValue <= ActivePointerStore.maxBytes,
          let data = try? Data(contentsOf: url),
          let pointer = try? JSONDecoder().decode(ActivePointer.self, from: data),
          pointer.isStructurallyValid else { return nil }
    return pointer
  }

  func write(_ pointer: ActivePointer) throws {
    guard pointer.isStructurallyValid else { throw NamuError(NamuError.invalidState, "pointer invalid") }
    try DurableFile.write(try pointer.encoded(), to: url)
  }

  func clear() throws {
    try DurableFile.remove(url)
  }
}
