import Foundation

/// Bounded structural GGUF check (DL-010, contract §6.4 step 3).
/// Runs only on files whose SHA-256 already matched the signed descriptor and
/// never uses the inference runtime's parser. Streams the metadata section
/// through a small buffer; tensor data is never touched and the file is never
/// loaded into memory. Mirrors model-release/dev/gguf-header.mjs.
enum GGUFCheck {
  struct Failure: Error, Equatable {
    let reason: String
  }

  static let maxKeyValues: UInt64 = 4096
  static let maxTensors: UInt64 = 65_536
  static let maxKeyLength: UInt64 = 1 << 20
  static let maxArchitectureLength: UInt64 = 256
  /// The metadata walk may not reach past this offset.
  static let headerWindow: UInt64 = 64 * 1024 * 1024

  private static let scalarSizes: [UInt32: UInt64] = [
    0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8,
  ]
  private static let typeString: UInt32 = 8
  private static let typeArray: UInt32 = 9

  /// Returns `general.architecture`. Any bound violation throws `Failure`.
  static func readArchitecture(at url: URL) throws -> String {
    let handle: FileHandle
    do {
      handle = try FileHandle(forReadingFrom: url)
    } catch {
      throw Failure(reason: "open failed")
    }
    defer { try? handle.close() }
    let size: UInt64
    do {
      size = try handle.seekToEnd()
      try handle.seek(toOffset: 0)
    } catch {
      throw Failure(reason: "seek failed")
    }
    var reader = BoundedReader(handle: handle, limit: min(size, headerWindow))

    let magic = try reader.read(4)
    guard magic == Data("GGUF".utf8) else { throw Failure(reason: "bad magic") }
    let version = try reader.u32()
    guard version == 2 || version == 3 else { throw Failure(reason: "unsupported version") }
    let tensors = try reader.u64()
    let keyValues = try reader.u64()
    guard tensors <= maxTensors, keyValues <= maxKeyValues else { throw Failure(reason: "counts out of bounds") }

    for _ in 0..<keyValues {
      let key = try reader.string(limit: maxKeyLength)
      let type = try reader.u32()
      if key == "general.architecture" {
        guard type == typeString else { throw Failure(reason: "architecture is not a string") }
        return try reader.string(limit: maxArchitectureLength)
      }
      try skipValue(&reader, type: type, depth: 0)
    }
    throw Failure(reason: "general.architecture missing")
  }

  private static func skipValue(_ reader: inout BoundedReader, type: UInt32, depth: Int) throws {
    if let size = scalarSizes[type] {
      try reader.skip(size)
    } else if type == typeString {
      try reader.skip(try reader.u64())
    } else if type == typeArray {
      guard depth <= 1 else { throw Failure(reason: "nested arrays not allowed") }
      let inner = try reader.u32()
      let count = try reader.u64()
      if let size = scalarSizes[inner] {
        let (bytes, overflow) = size.multipliedReportingOverflow(by: count)
        guard !overflow else { throw Failure(reason: "array too large") }
        try reader.skip(bytes)
      } else {
        // Every element consumes at least four bytes, so the window bounds
        // this loop even for a hostile count.
        guard count <= headerWindow else { throw Failure(reason: "array too large") }
        for _ in 0..<count { try skipValue(&reader, type: inner, depth: depth + 1) }
      }
    } else {
      throw Failure(reason: "unknown value type")
    }
  }

  /// Sequential reader over the first `limit` bytes with a 64 KiB buffer.
  private struct BoundedReader {
    let handle: FileHandle
    let limit: UInt64
    private var buffer = Data()
    private var bufferStart: UInt64 = 0 // file offset of buffer[0]
    private var position: UInt64 = 0 // absolute file offset of the cursor
    private static let chunk = 64 * 1024

    init(handle: FileHandle, limit: UInt64) {
      self.handle = handle
      self.limit = limit
    }

    private func need(_ count: UInt64) throws {
      let (end, overflow) = position.addingReportingOverflow(count)
      guard !overflow, end <= limit else { throw Failure(reason: "metadata exceeds header window") }
    }

    mutating func skip(_ count: UInt64) throws {
      try need(count)
      position += count
    }

    mutating func read(_ count: Int) throws -> Data {
      try need(UInt64(count))
      var out = Data(capacity: count)
      while out.count < count {
        let bufferEnd = bufferStart + UInt64(buffer.count)
        if position < bufferStart || position >= bufferEnd {
          do {
            try handle.seek(toOffset: position)
            let wanted = Int(min(UInt64(max(BoundedReader.chunk, count - out.count)), limit - position))
            buffer = try handle.read(upToCount: wanted) ?? Data()
          } catch {
            throw Failure(reason: "read failed")
          }
          bufferStart = position
          guard !buffer.isEmpty else { throw Failure(reason: "truncated metadata") }
        }
        let offset = Int(position - bufferStart)
        let take = min(count - out.count, buffer.count - offset)
        out.append(buffer.subdata(in: (buffer.startIndex + offset)..<(buffer.startIndex + offset + take)))
        position += UInt64(take)
      }
      return out
    }

    mutating func u32() throws -> UInt32 {
      let data = try read(4)
      return data.enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * UInt32($1.offset)) }
    }

    mutating func u64() throws -> UInt64 {
      let data = try read(8)
      return data.enumerated().reduce(UInt64(0)) { $0 | UInt64($1.element) << (8 * UInt64($1.offset)) }
    }

    mutating func string(limit: UInt64) throws -> String {
      let length = try u64()
      guard length <= limit else { throw Failure(reason: "string too long") }
      let data = try read(Int(length))
      guard let text = String(data: data, encoding: .utf8) else { throw Failure(reason: "string is not utf-8") }
      return text
    }
  }
}
