import XCTest
@testable import Namu

/// Contract §4.1 / SIG-003.
final class StrictJSONTests: XCTestCase {
  func testParsesNestedDocument() throws {
    let value = try StrictJSON.parse(#"{"a": [1, -2, 3.5, true, false, null], "b": {"c": "d"}, "e": "x\n\u00e9\ud83d\ude00"}"#)
    guard case .object(let map) = value else { return XCTFail("not an object") }
    XCTAssertEqual(map["a"], .array([
      .number(integer: 1, double: 1), .number(integer: -2, double: -2), .number(integer: nil, double: 3.5),
      .bool(true), .bool(false), .null,
    ]))
    XCTAssertEqual(value.string("e"), "x\né😀")
    XCTAssertEqual(map["b"]?.string("c"), "d")
  }

  func testRejectsDuplicateKeysAtAnyDepth() {
    XCTAssertThrowsError(try StrictJSON.parse(#"{"a":1,"a":2}"#))
    XCTAssertThrowsError(try StrictJSON.parse(#"{"x":{"y":[{"k":1,"k":1}]}}"#))
    // Duplicates are detected after escape decoding.
    XCTAssertThrowsError(try StrictJSON.parse(#"{"a":1,"\u0061":2}"#))
    XCTAssertNoThrow(try StrictJSON.parse(#"{"a":1,"A":2}"#))
  }

  func testRejectsTrailingDataAndGarbage() {
    for text in ["{} x", "{}{}", "[1,]", "{\"a\":1,}", "", "  ", "nul", "01", "1.", "1e", "-", "+1", ".5",
                 "\"abc", "\"\\x\"", "\"\\u12G4\"", "\"a\tb\"", "{\"a\" 1}", "{a:1}", "[1 2]", "\u{FEFF}{}"] {
      XCTAssertThrowsError(try StrictJSON.parse(text), "should reject: \(text)")
    }
  }

  func testRejectsLoneSurrogates() {
    XCTAssertThrowsError(try StrictJSON.parse(#""\ud83d""#))
    XCTAssertThrowsError(try StrictJSON.parse(#""\ude00""#))
    XCTAssertThrowsError(try StrictJSON.parse(#""\ud83dx""#))
  }

  func testRejectsInvalidUTF8() {
    XCTAssertThrowsError(try StrictJSON.parse(Data([0x22, 0xff, 0xfe, 0x22])))
    XCTAssertThrowsError(try StrictJSON.parse(Data([0x22, 0xc3, 0x22]))) // truncated sequence
  }

  func testIntegersAreExact() throws {
    XCTAssertEqual(try StrictJSON.parse("9007199254740991"), .number(integer: 9_007_199_254_740_991, double: 9_007_199_254_740_991))
    XCTAssertThrowsError(try StrictJSON.parse("9007199254740992"))
    XCTAssertThrowsError(try StrictJSON.parse("-9223372036854775808"))
    XCTAssertThrowsError(try StrictJSON.parse("123456789012345678901234567890"))
    // Fractions and exponents are numbers, but never integers.
    let doc = try StrictJSON.parse(#"{"bytes": 1.0, "exp": 1e3, "int": 10}"#)
    XCTAssertNil(doc.integer("bytes"))
    XCTAssertNil(doc.integer("exp"))
    XCTAssertEqual(doc.integer("int"), 10)
  }

  func testDepthLimit() {
    let ok = String(repeating: "[", count: 16) + String(repeating: "]", count: 16)
    let tooDeep = String(repeating: "[", count: 17) + String(repeating: "]", count: 17)
    XCTAssertNoThrow(try StrictJSON.parse(ok))
    XCTAssertThrowsError(try StrictJSON.parse(tooDeep))
  }

  func testTypedAccessorsRejectWrongTypes() throws {
    let doc = try StrictJSON.parse(#"{"s": 1, "n": "1", "arr": ["a", 2]}"#)
    XCTAssertNil(doc.string("s"))
    XCTAssertNil(doc.integer("n"))
    XCTAssertNil(doc.stringArray("arr"))
    XCTAssertNil(doc.string("missing"))
  }

  func testPreservesHausaLetters() throws {
    XCTAssertEqual(try StrictJSON.parse(#"{"t":"ƙwai ɗaya ɓera"}"#).string("t"), "ƙwai ɗaya ɓera")
  }
}
