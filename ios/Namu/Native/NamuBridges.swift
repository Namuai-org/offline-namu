import Foundation

// Objective-C facades consumed by the TurboModule shims through Namu-Swift.h.
// They are `public` because an app target without a bridging header only
// exports public declarations into the generated header. Callbacks carry
// `(value, errorCode, errorMessage)`; exactly one of value/errorCode is set
// (Void results report an empty string). Messages never contain chat text,
// paths or headers.

public typealias NamuStringCallback = (String?, String?, String?) -> Void
public typealias NamuNumberCallback = (NSNumber?, String?, String?) -> Void

private func deliver(_ result: Result<String, NamuError>, _ callback: NamuStringCallback) {
  switch result {
  case .success(let value): callback(value, nil, nil)
  case .failure(let error): callback(nil, error.code, error.message)
  }
}

private func deliver(_ result: Result<Void, NamuError>, _ callback: NamuStringCallback) {
  deliver(result.map { "" }, callback)
}

@objc(NamuTransferBridge)
public final class NamuTransferBridge: NSObject {
  private static var service: TransferService { TransferService.shared }

  @objc public static func addSnapshotListener(_ listener: @escaping (String) -> Void) -> String {
    service.addSnapshotListener(listener).uuidString
  }

  @objc public static func removeSnapshotListener(_ token: String) {
    if let uuid = UUID(uuidString: token) { service.removeSnapshotListener(uuid) }
  }

  @objc public static func snapshot(_ callback: @escaping NamuStringCallback) {
    service.snapshot { deliver($0, callback) }
  }

  @objc public static func bundledDescriptorSummary(_ callback: @escaping NamuStringCallback) {
    service.bundledDescriptorSummary { deliver($0, callback) }
  }

  @objc public static func start(source: String, allowMetered: Bool, callback: @escaping NamuStringCallback) {
    service.start(source: source, allowMetered: allowMetered) { deliver($0, callback) }
  }

  @objc public static func pause(transferId: String, callback: @escaping NamuStringCallback) {
    service.pause(transferId: transferId) { deliver($0, callback) }
  }

  @objc public static func resume(transferId: String, allowMetered: Bool, callback: @escaping NamuStringCallback) {
    service.resume(transferId: transferId, allowMetered: allowMetered) { deliver($0, callback) }
  }

  @objc public static func cancel(transferId: String, callback: @escaping NamuStringCallback) {
    service.cancel(transferId: transferId) { deliver($0, callback) }
  }

  @objc public static func checkForUpdate(_ callback: @escaping NamuStringCallback) {
    service.checkForUpdate { deliver($0, callback) }
  }

  @objc public static func beginSelfTest(transferId: String, callback: @escaping NamuStringCallback) {
    service.beginSelfTest(transferId: transferId) { deliver($0, callback) }
  }

  @objc public static func activate(
    transferId: String, selfTestPassed: Bool, failureCode: String, callback: @escaping NamuStringCallback
  ) {
    service.activate(transferId: transferId, selfTestPassed: selfTestPassed, failureCode: failureCode) {
      deliver($0, callback)
    }
  }

  @objc public static func resolveArtifactPath(_ artifactId: String, callback: @escaping NamuStringCallback) {
    service.resolveArtifactPath(artifactId: artifactId) { deliver($0, callback) }
  }

  @objc public static func setRuntimeReference(_ artifactId: String) {
    service.setRuntimeReference(artifactId)
  }

  @objc public static func noteSuccessfulForegroundSession(_ callback: @escaping NamuStringCallback) {
    service.noteSuccessfulForegroundSession { deliver($0, callback) }
  }

  @objc public static func restorePrevious(markAbandonedBad: Bool, callback: @escaping NamuStringCallback) {
    service.restorePrevious(markAbandonedBad: markAbandonedBad) { deliver($0, callback) }
  }

  @objc public static func repair(_ callback: @escaping NamuStringCallback) {
    service.repair { deliver($0, callback) }
  }

  @objc public static func removeModel(_ callback: @escaping NamuStringCallback) {
    service.removeModel { deliver($0, callback) }
  }

  @objc public static func deleteAllTransferData(_ callback: @escaping NamuStringCallback) {
    service.deleteAllTransferData { deliver($0, callback) }
  }
}

@objc(NamuExportBridge)
public final class NamuExportBridge: NSObject {
  private static var service: ExportService { ExportService.shared }

  @objc public static func exportConversation(
    dbDirectory: String, conversationId: String, labelsJson: String, callback: @escaping NamuStringCallback
  ) {
    service.exportConversation(dbDirectory: dbDirectory, conversationId: conversationId, labelsJSON: labelsJson) {
      deliver($0, callback)
    }
  }

  @objc public static func exportAllConversations(
    dbDirectory: String, labelsJson: String, callback: @escaping NamuStringCallback
  ) {
    service.exportAllConversations(dbDirectory: dbDirectory, labelsJSON: labelsJson) { deliver($0, callback) }
  }

  @objc public static func share(_ exportId: String, callback: @escaping NamuNumberCallback) {
    service.share(exportId) { result in
      switch result {
      case .success(let completed): callback(NSNumber(value: completed), nil, nil)
      case .failure(let error): callback(nil, error.code, error.message)
      }
    }
  }

  @objc public static func deleteExport(_ exportId: String, callback: @escaping NamuStringCallback) {
    service.deleteExport(exportId) { deliver($0, callback) }
  }

  @objc public static func sweepExports(_ callback: @escaping NamuNumberCallback) {
    service.sweepExports { result in
      switch result {
      case .success(let count): callback(NSNumber(value: count), nil, nil)
      case .failure(let error): callback(nil, error.code, error.message)
      }
    }
  }

  @objc public static func deleteAllExports(_ callback: @escaping NamuStringCallback) {
    service.deleteAllExports { deliver($0, callback) }
  }
}

@objc(NamuPlatformBridge)
public final class NamuPlatformBridge: NSObject {
  private static var service: PlatformService { PlatformService.shared }

  @objc public static func constants() -> [String: Any] {
    let c = service.constants()
    return [
      "appVersion": c.appVersion, "appBuild": c.appBuild, "osName": c.osName, "osVersion": c.osVersion,
      "deviceModel": c.deviceModel, "isSimulator": c.isSimulator, "isInternalBuild": c.isInternalBuild,
    ]
  }

  @objc public static func addThermalListener(_ listener: @escaping (String) -> Void) -> String {
    service.start()
    return service.addThermalListener(listener).uuidString
  }

  @objc public static func addMemoryListener(_ listener: @escaping (String) -> Void) -> String {
    service.start()
    return service.addMemoryListener(listener).uuidString
  }

  @objc public static func addSendShortcutListener(_ listener: @escaping (String) -> Void) -> String {
    service.addSendShortcutListener(listener).uuidString
  }

  @objc public static func removeListener(_ token: String) {
    if let uuid = UUID(uuidString: token) { service.removeListener(uuid) }
  }

  @objc public static func deviceProfileJSON() -> String { service.deviceProfileJSON() }
  @objc public static func preferredLocales() -> [String] { service.preferredLocales() }
  @objc public static func randomUUID() -> String { service.randomUUID() }
  @objc public static func thermalState() -> String { service.thermalState() }
  @objc public static func availableMemoryBytes() -> Double { service.availableMemoryBytes() }
  @objc public static func copyToClipboard(_ text: String) { service.copyToClipboard(text) }
  @objc public static func haptic(_ kind: String) { service.haptic(kind) }
  @objc public static func chatDataSizeBytes() -> Double { service.chatDataSizeBytes() }

  @objc public static func isReduceMotionEnabled(_ callback: @escaping (Bool) -> Void) {
    service.isReduceMotionEnabled(callback)
  }

  @objc public static func prepareChatDataDirectory(_ callback: @escaping NamuStringCallback) {
    deliver(Result { try service.prepareChatDataDirectory() }
      .mapError { NamuError.wrap($0, fallback: NamuError.storageWriteFailed) }, callback)
  }

  @objc public static func deleteChatData(_ callback: @escaping NamuStringCallback) {
    deliver(Result { try service.deleteChatData() }
      .mapError { NamuError.wrap($0, fallback: NamuError.storageWriteFailed) }, callback)
  }
}
