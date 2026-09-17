import Foundation

/// Stable error codes that cross the bridge (PRD §17 + contract §6.5).
/// The `message` is diagnostic only: it never contains chat text, file system
/// paths or HTTP headers (SEC-002, OBS-001).
struct NamuError: Error, Equatable {
  let code: String
  let message: String

  init(_ code: String, _ message: String = "") {
    self.code = code
    self.message = message
  }

  // PRD §17
  static let deviceIneligible = "DEVICE_INELIGIBLE"
  static let spaceLow = "SPACE_LOW"
  static let networkWait = "NETWORK_WAIT"
  static let transferRetry = "TRANSFER_RETRY"
  static let transferRestart = "TRANSFER_RESTART"
  static let signatureInvalid = "SIGNATURE_INVALID"
  static let fileDamaged = "FILE_DAMAGED"
  static let modelIncompatible = "MODEL_INCOMPATIBLE"
  static let modelLoadFailed = "MODEL_LOAD_FAILED"
  static let memoryLow = "MEMORY_LOW"
  static let deviceHot = "DEVICE_HOT"
  static let storageWriteFailed = "STORAGE_WRITE_FAILED"
  static let databaseRecovery = "DATABASE_RECOVERY"
  // Contract §6.5
  static let engineBusy = "ENGINE_BUSY"
  static let notFound = "NOT_FOUND"
  static let invalidState = "INVALID_STATE"

  /// Codes JS may hand back through `activate(…, failureCode)`.
  static let productCodes: Set<String> = [
    deviceIneligible, spaceLow, networkWait, transferRetry, transferRestart,
    signatureInvalid, fileDamaged, modelIncompatible, modelLoadFailed, memoryLow,
    deviceHot, "INPUT_TOO_LONG", "ANSWER_INTERRUPTED", storageWriteFailed,
    databaseRecovery, "CANCEL_TIMEOUT",
  ]

  /// Maps any thrown error to a contract error without leaking details.
  static func wrap(_ error: Error, fallback: String) -> NamuError {
    if let namu = error as? NamuError { return namu }
    return NamuError(fallback, String(describing: type(of: error)))
  }
}

enum NamuConstants {
  static let modelId = "namu-aya-global"
  static let understoodPromptVersions = ["namu-text-1"]
  static let bundledLicenseNoticeIds = ["tiny-aya-cc-by-nc-4.0-v1"]
  static let gib: Int64 = 1 << 30
  static let mib: Int64 = 1 << 20
  /// DL-009: additional headroom required before a transfer starts/resumes.
  static let startReserveBytes: Int64 = gib
  /// DL-009: pause when free space falls below this while transferring.
  static let runningReserveBytes: Int64 = 256 * mib
}

func namuNowMs() -> Int64 {
  Int64((Date().timeIntervalSince1970 * 1000).rounded())
}

extension Data {
  var namuHex: String {
    let digits = Array("0123456789abcdef".utf8)
    var out = [UInt8]()
    out.reserveCapacity(count * 2)
    for byte in self {
      out.append(digits[Int(byte >> 4)])
      out.append(digits[Int(byte & 0x0f)])
    }
    return String(decoding: out, as: UTF8.self)
  }
}

enum NamuPattern {
  /// `^[0-9a-f]{64}$` without regex machinery.
  static func isSha256Hex(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    return bytes.count == 64 && bytes.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
  }

  static func isLowerHex(_ value: String, length: Int) -> Bool {
    let bytes = Array(value.utf8)
    return bytes.count == length && bytes.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
  }

  /// Lower-case UUID string as produced by `UUID().uuidString.lowercased()`.
  static func isUUID(_ value: String) -> Bool {
    UUID(uuidString: value) != nil && value.utf8.count == 36
  }
}
