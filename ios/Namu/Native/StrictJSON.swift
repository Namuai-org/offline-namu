import Foundation

/// Strict RFC 8259 parser for signed descriptors (SIG-003, contract §4.1).
/// Mirrors model-release/descriptor/strict-json.mjs: UTF-8 only, depth ≤ 16,
/// duplicate object keys at any depth are an error, integers are exact, no
/// trailing data. `JSONSerialization` silently keeps the last duplicate and
/// MUST NOT be used for descriptors.
enum StrictJSONValue: Equatable {
  case object([String: StrictJSONValue])
  case array([StrictJSONValue])
  case string(String)
  /// `integer` is non-nil only for literals without fraction/exponent.
  case number(integer: Int64?, double: Double)
  case bool(Bool)
  case null

  func string(_ key: String) -> String? {
    guard case .object(let map) = self, case .string(let value)? = map[key] else { return nil }
    return value
  }

  func integer(_ key: String) -> Int64? {
    guard case .object(let map) = self, case .number(let integer, _)? = map[key] else { return nil }
    return integer
  }

  func stringArray(_ key: String) -> [String]? {
    guard case .object(let map) = self, case .array(let items)? = map[key] else { return nil }
    var out = [String]()
    for item in items {
      guard case .string(let value) = item else { return nil }
      out.append(value)
    }
    return out
  }
}

struct StrictJSONError: Error, Equatable {
  let message: String
  let offset: Int
}

enum StrictJSON {
  static let maxDepth = 16
  private static let maxSafeInteger: Int64 = 9_007_199_254_740_991 // 2^53 − 1

  static func parse(_ data: Data) throws -> StrictJSONValue {
    // UTF-8 only. A byte-order mark is not JSON (RFC 8259 §8.1).
    guard String(data: data, encoding: .utf8) != nil else {
      throw StrictJSONError(message: "invalid utf-8", offset: 0)
    }
    var parser = Parser(bytes: [UInt8](data))
    let value = try parser.parseValue(depth: 1)
    parser.skipWhitespace()
    guard parser.index == parser.bytes.count else { throw parser.fail("trailing data") }
    return value
  }

  static func parse(_ text: String) throws -> StrictJSONValue {
    try parse(Data(text.utf8))
  }

  private struct Parser {
    let bytes: [UInt8]
    var index = 0

    func fail(_ message: String) -> StrictJSONError {
      StrictJSONError(message: message, offset: index)
    }

    var current: UInt8? { index < bytes.count ? bytes[index] : nil }

    mutating func skipWhitespace() {
      while let c = current, c == 0x20 || c == 0x0a || c == 0x0d || c == 0x09 { index += 1 }
    }

    mutating func parseValue(depth: Int) throws -> StrictJSONValue {
      if depth > StrictJSON.maxDepth { throw fail("too deep") }
      skipWhitespace()
      guard let c = current else { throw fail("unexpected end") }
      switch c {
      case UInt8(ascii: "{"): return try parseObject(depth: depth)
      case UInt8(ascii: "["): return try parseArray(depth: depth)
      case UInt8(ascii: "\""): return .string(try parseString())
      case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"): return try parseNumber()
      default:
        if consume(literal: "true") { return .bool(true) }
        if consume(literal: "false") { return .bool(false) }
        if consume(literal: "null") { return .null }
        throw fail("unexpected token")
      }
    }

    private mutating func consume(literal: String) -> Bool {
      let expected = Array(literal.utf8)
      guard index + expected.count <= bytes.count,
            Array(bytes[index..<index + expected.count]) == expected else { return false }
      index += expected.count
      return true
    }

    private mutating func parseObject(depth: Int) throws -> StrictJSONValue {
      index += 1 // {
      var map = [String: StrictJSONValue]()
      skipWhitespace()
      if current == UInt8(ascii: "}") { index += 1; return .object(map) }
      while true {
        skipWhitespace()
        guard current == UInt8(ascii: "\"") else { throw fail("expected key") }
        let key = try parseString()
        // SIG-003: duplicates are rejected after escape decoding.
        if map[key] != nil { throw fail("duplicate key") }
        skipWhitespace()
        guard current == UInt8(ascii: ":") else { throw fail("expected colon") }
        index += 1
        map[key] = try parseValue(depth: depth + 1)
        skipWhitespace()
        if current == UInt8(ascii: ",") { index += 1; continue }
        if current == UInt8(ascii: "}") { index += 1; return .object(map) }
        throw fail("expected , or }")
      }
    }

    private mutating func parseArray(depth: Int) throws -> StrictJSONValue {
      index += 1 // [
      var items = [StrictJSONValue]()
      skipWhitespace()
      if current == UInt8(ascii: "]") { index += 1; return .array(items) }
      while true {
        items.append(try parseValue(depth: depth + 1))
        skipWhitespace()
        if current == UInt8(ascii: ",") { index += 1; continue }
        if current == UInt8(ascii: "]") { index += 1; return .array(items) }
        throw fail("expected , or ]")
      }
    }

    private mutating func parseHex4() throws -> UInt32 {
      guard index + 4 <= bytes.count else { throw fail("bad unicode escape") }
      var value: UInt32 = 0
      for _ in 0..<4 {
        let c = bytes[index]
        let digit: UInt32
        switch c {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = UInt32(c - UInt8(ascii: "0"))
        case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = UInt32(c - UInt8(ascii: "a")) + 10
        case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = UInt32(c - UInt8(ascii: "A")) + 10
        default: throw fail("bad unicode escape")
        }
        value = value << 4 | digit
        index += 1
      }
      return value
    }

    private mutating func parseString() throws -> String {
      index += 1 // opening quote
      var out = [UInt8]()
      while true {
        guard let c = current else { throw fail("unterminated string") }
        if c == UInt8(ascii: "\"") {
          index += 1
          // Input was validated as UTF-8 and escapes append valid scalars.
          return String(decoding: out, as: UTF8.self)
        }
        if c < 0x20 { throw fail("control character in string") }
        if c != UInt8(ascii: "\\") {
          out.append(c)
          index += 1
          continue
        }
        index += 1
        guard let escape = current else { throw fail("bad escape") }
        index += 1
        switch escape {
        case UInt8(ascii: "\""): out.append(0x22)
        case UInt8(ascii: "\\"): out.append(0x5c)
        case UInt8(ascii: "/"): out.append(0x2f)
        case UInt8(ascii: "b"): out.append(0x08)
        case UInt8(ascii: "f"): out.append(0x0c)
        case UInt8(ascii: "n"): out.append(0x0a)
        case UInt8(ascii: "r"): out.append(0x0d)
        case UInt8(ascii: "t"): out.append(0x09)
        case UInt8(ascii: "u"):
          var scalarValue = try parseHex4()
          if (0xD800...0xDBFF).contains(scalarValue) {
            // A high surrogate must be followed by an escaped low surrogate.
            guard index + 2 <= bytes.count, bytes[index] == UInt8(ascii: "\\"),
                  bytes[index + 1] == UInt8(ascii: "u") else { throw fail("lone surrogate") }
            index += 2
            let low = try parseHex4()
            guard (0xDC00...0xDFFF).contains(low) else { throw fail("lone surrogate") }
            scalarValue = 0x10000 + ((scalarValue - 0xD800) << 10) + (low - 0xDC00)
          } else if (0xDC00...0xDFFF).contains(scalarValue) {
            throw fail("lone surrogate")
          }
          guard let scalar = Unicode.Scalar(scalarValue) else { throw fail("bad unicode escape") }
          out.append(contentsOf: Array(String(Character(scalar)).utf8))
        default:
          index -= 1
          throw fail("bad escape")
        }
      }
    }

    private mutating func parseNumber() throws -> StrictJSONValue {
      let start = index
      if current == UInt8(ascii: "-") { index += 1 }
      guard let first = current, first >= UInt8(ascii: "0"), first <= UInt8(ascii: "9") else {
        throw fail("bad number")
      }
      if first == UInt8(ascii: "0") {
        index += 1 // a leading zero stands alone; "01" fails at the caller
      } else {
        while let c = current, c >= UInt8(ascii: "0"), c <= UInt8(ascii: "9") { index += 1 }
      }
      var isInteger = true
      if current == UInt8(ascii: ".") {
        let mark = index
        index += 1
        var digits = 0
        while let c = current, c >= UInt8(ascii: "0"), c <= UInt8(ascii: "9") { index += 1; digits += 1 }
        if digits == 0 { index = mark; throw fail("bad number") }
        isInteger = false
      }
      if current == UInt8(ascii: "e") || current == UInt8(ascii: "E") {
        let mark = index
        index += 1
        if current == UInt8(ascii: "+") || current == UInt8(ascii: "-") { index += 1 }
        var digits = 0
        while let c = current, c >= UInt8(ascii: "0"), c <= UInt8(ascii: "9") { index += 1; digits += 1 }
        if digits == 0 { index = mark; throw fail("bad number") }
        isInteger = false
      }
      let text = String(decoding: bytes[start..<index], as: UTF8.self)
      if isInteger {
        // Exact integers only, inside the IEEE-754 safe range shared with JS.
        guard let value = Int64(text), value.magnitude <= UInt64(StrictJSON.maxSafeInteger) else {
          throw fail("integer out of range")
        }
        return .number(integer: value, double: Double(value))
      }
      return .number(integer: nil, double: Double(text) ?? .nan)
    }
  }
}
