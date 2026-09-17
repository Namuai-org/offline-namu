import CryptoKit
import Foundation

/// Streaming SHA-256 (DL-010, contract §6.4 step 2). The file is read through
/// one reusable 8 MiB window; hash state is never serialized (DL-004).
enum Sha256Streamer {
  static let bufferSize = 8 * 1024 * 1024

  struct Cancelled: Error {}

  /// - Parameters:
  ///   - progress: called with the total number of bytes hashed so far.
  ///   - isCancelled: polled between buffers; throws `Cancelled` when true.
  /// - Returns: lower-case hex digest.
  static func hashFile(
    at url: URL,
    bufferSize: Int = Sha256Streamer.bufferSize,
    progress: ((Int64) -> Void)? = nil,
    isCancelled: (() -> Bool)? = nil
  ) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    var total: Int64 = 0
    while true {
      if isCancelled?() == true { throw Cancelled() }
      // The pool releases each 8 MiB chunk before the next one is read.
      let count: Int = try autoreleasepool {
        guard let chunk = try handle.read(upToCount: bufferSize), !chunk.isEmpty else { return 0 }
        hasher.update(data: chunk)
        return chunk.count
      }
      if count == 0 { break }
      total += Int64(count)
      progress?(total)
    }
    return Data(hasher.finalize()).namuHex
  }
}
