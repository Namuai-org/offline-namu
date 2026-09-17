import XCTest
@testable import Namu

/// Contract §6.4 step 3: bounded structural check on synthesized headers.
final class GGUFCheckTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws { directory = try TestSupport.makeTemporaryDirectory("gguf") }
  override func tearDown() { TestSupport.remove(directory) }

  // MARK: - Little-endian builders

  private func u32(_ v: UInt32) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
  private func u64(_ v: UInt64) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
  /// Explicit concatenation keeps the type checker fast.
  private func join(_ parts: [Data]) -> Data { parts.reduce(into: Data()) { $0.append($1) } }
  private func str(_ s: String) -> Data { join([u64(UInt64(s.utf8.count)), Data(s.utf8)]) }
  private func kvString(_ key: String, _ value: String) -> Data { join([str(key), u32(8), str(value)]) }
  private func kvU32(_ key: String, _ value: UInt32) -> Data { join([str(key), u32(4), u32(value)]) }

  private func header(version: UInt32 = 3, tensors: UInt64 = 2, kvCount: UInt64, magic: String = "GGUF") -> Data {
    join([Data(magic.utf8), u32(version), u64(tensors), u64(kvCount)])
  }

  private func write(_ data: Data) throws -> URL {
    let url = directory.appendingPathComponent(UUID().uuidString + ".gguf")
    try data.write(to: url)
    return url
  }

  private func assertDamaged(_ data: Data, _ reason: String, file: StaticString = #filePath, line: UInt = #line) throws {
    let url = try write(data)
    XCTAssertThrowsError(try GGUFCheck.readArchitecture(at: url), file: file, line: line) { error in
      XCTAssertEqual((error as? GGUFCheck.Failure)?.reason, reason, file: file, line: line)
    }
  }

  // MARK: - Valid headers

  func testArchitectureAsFirstKey() throws {
    let url = try write(join([header(kvCount: 1), kvString("general.architecture", "cohere2"), Data(count: 4096)]))
    XCTAssertEqual(try GGUFCheck.readArchitecture(at: url), "cohere2")
  }

  func testVersion2AndValuesOfEveryKindBeforeArchitecture() throws {
    let nestedFirst = join([u32(4), u64(1), u32(7)])
    let nestedSecond = join([u32(4), u64(2), u32(8), u32(9)])
    let body = join([
      header(version: 2, kvCount: 7),
      kvU32("general.alignment", 32),
      join([str("flag"), u32(7), Data([1])]), // bool
      join([str("f64"), u32(12), u64(0)]),
      // array of strings (tokenizer vocab shape)
      join([str("tokenizer.ggml.tokens"), u32(9), u32(8), u64(3), str("a"), str("bb"), str("ccc")]),
      // large scalar array that must be skipped by size, spanning several buffers
      join([str("scores"), u32(9), u32(6), u64(100_000), Data(count: 400_000)]),
      // array of arrays (one nesting level is allowed)
      join([str("nested"), u32(9), u32(9), u64(2), nestedFirst, nestedSecond]),
      kvString("general.architecture", "llama"),
      Data(count: 1024),
    ])
    let url = try write(body)
    XCTAssertEqual(try GGUFCheck.readArchitecture(at: url), "llama")
  }

  // MARK: - Invalid headers

  func testRejectsBadMagicVersionAndCounts() throws {
    let arch = kvString("general.architecture", "x")
    try assertDamaged(join([header(kvCount: 1, magic: "GGML"), arch]), "bad magic")
    try assertDamaged(join([header(version: 1, kvCount: 1), arch]), "unsupported version")
    try assertDamaged(join([header(version: 4, kvCount: 1), arch]), "unsupported version")
    try assertDamaged(header(kvCount: 4097), "counts out of bounds")
    try assertDamaged(header(tensors: 65_537, kvCount: 1), "counts out of bounds")
    try assertDamaged(Data("GG".utf8), "metadata exceeds header window")
    try assertDamaged(Data(), "metadata exceeds header window")
  }

  func testRejectsMissingOrMistypedArchitecture() throws {
    try assertDamaged(join([header(kvCount: 1), kvU32("general.alignment", 32)]), "general.architecture missing")
    try assertDamaged(join([header(kvCount: 1), kvU32("general.architecture", 1)]), "architecture is not a string")
    let longValue = join([header(kvCount: 1), str("general.architecture"), u32(8), u64(257), Data(count: 257)])
    try assertDamaged(longValue, "string too long")
  }

  func testRejectsTruncatedAndHostileLengths() throws {
    // kv count promises more than the file holds
    try assertDamaged(join([header(kvCount: 2), kvU32("general.alignment", 32)]), "metadata exceeds header window")
    // key length far beyond the limit
    try assertDamaged(join([header(kvCount: 1), u64(1 << 40)]), "string too long")
    // value string running past the end of the file
    try assertDamaged(join([header(kvCount: 2), str("k"), u32(8), u64(1 << 30)]), "metadata exceeds header window")
    // scalar array whose byte size overflows UInt64
    try assertDamaged(join([header(kvCount: 2), str("k"), u32(9), u32(12), u64(UInt64.max)]), "array too large")
    // string array with an absurd element count
    try assertDamaged(join([header(kvCount: 2), str("k"), u32(9), u32(8), u64(UInt64.max)]), "array too large")
    try assertDamaged(join([header(kvCount: 2), str("k"), u32(99)]), "unknown value type")
  }

  func testRejectsArraysNestedTooDeep() throws {
    let innermost = join([u32(4), u64(1), u32(1)])
    let inner = join([u32(9), u64(1), innermost]) // array<array<u32>>
    let body = join([header(kvCount: 2), str("deep"), u32(9), u32(9), u64(1), inner])
    try assertDamaged(join([body, kvString("general.architecture", "x")]), "nested arrays not allowed")
  }

  func testNeverReadsPastTheHeaderWindowOfAHugeSparseFile() throws {
    // 3 GiB sparse file: only the header exists on disk. The check must finish
    // from the first bytes without loading the file.
    let url = try write(join([header(kvCount: 1), kvString("general.architecture", "cohere2")]))
    let handle = try FileHandle(forWritingTo: url)
    try handle.truncate(atOffset: 3 * 1024 * 1024 * 1024)
    try handle.close()
    XCTAssertEqual(try GGUFCheck.readArchitecture(at: url), "cohere2")
  }
}
