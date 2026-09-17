import Foundation
import Metal
import UIKit
import os

/// Device, lifecycle and small OS services (contract §2). Observers are
/// installed at app launch, so thermal and memory events reach the JS
/// controller even when no React screen is mounted (INF-007).
final class PlatformService {
  static let shared = PlatformService()

  private let lock = NSLock()
  private var thermalListeners = [UUID: (String) -> Void]()
  private var memoryListeners = [UUID: (String) -> Void]()
  private var sendShortcutListeners = [UUID: (String) -> Void]()
  private var observers = [NSObjectProtocol]()
  private var pressureSource: DispatchSourceMemoryPressure?
  private var started = false

  // MARK: - Lifecycle

  func start() {
    lock.lock()
    defer { lock.unlock() }
    guard !started else { return }
    started = true
    let center = NotificationCenter.default
    // INF-008: notification driven; thermal headroom is never polled.
    observers.append(center.addObserver(
      forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil
    ) { [weak self] _ in self?.emitThermal() })
    observers.append(center.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: nil
    ) { [weak self] _ in self?.emitMemory("critical") })
    // Early signal before UIKit's warning; maps to the contract's `warning`.
    let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning], queue: .global(qos: .utility))
    source.setEventHandler { [weak self] in self?.emitMemory("warning") }
    source.resume()
    pressureSource = source
  }

  func addThermalListener(_ listener: @escaping (String) -> Void) -> UUID {
    let token = UUID()
    lock.lock(); thermalListeners[token] = listener; lock.unlock()
    return token
  }

  func addMemoryListener(_ listener: @escaping (String) -> Void) -> UUID {
    let token = UUID()
    lock.lock(); memoryListeners[token] = listener; lock.unlock()
    return token
  }

  func addSendShortcutListener(_ listener: @escaping (String) -> Void) -> UUID {
    let token = UUID()
    lock.lock(); sendShortcutListeners[token] = listener; lock.unlock()
    return token
  }

  func removeListener(_ token: UUID) {
    lock.lock()
    thermalListeners[token] = nil
    memoryListeners[token] = nil
    sendShortcutListeners[token] = nil
    lock.unlock()
  }

  /// A11Y-002: Cmd+Return on a hardware keyboard. The key command itself is
  /// registered by AppDelegate (end of the responder chain); a plain Return is
  /// never intercepted and keeps inserting a newline in the composer.
  func emitSendShortcut(source: String = "hardware-keyboard") {
    lock.lock(); let listeners = Array(sendShortcutListeners.values); lock.unlock()
    listeners.forEach { $0(source) }
  }

  private func emitThermal() {
    lock.lock(); let listeners = Array(thermalListeners.values); lock.unlock()
    let state = thermalState()
    listeners.forEach { $0(state) }
  }

  private func emitMemory(_ level: String) {
    lock.lock(); let listeners = Array(memoryListeners.values); lock.unlock()
    listeners.forEach { $0(level) }
  }

  // MARK: - Constants and device profile

  struct Constants {
    let appVersion: String
    let appBuild: Double
    let osName: String
    let osVersion: String
    let deviceModel: String
    let isSimulator: Bool
    let isInternalBuild: Bool
  }

  static var isSimulator: Bool {
    #if targetEnvironment(simulator)
    return true
    #else
    return false
    #endif
  }

  func constants() -> Constants {
    let config = NamuBuildConfig.current
    return Constants(
      appVersion: config.appVersion, appBuild: Double(config.appBuild), osName: "iOS",
      osVersion: UIDevice.current.systemVersion, deviceModel: PlatformService.hardwareModel(),
      isSimulator: PlatformService.isSimulator, isInternalBuild: config.isInternalBuild)
  }

  /// Coarse hardware identifier such as "iPhone16,1" (OBS-001: no device IDs).
  static func hardwareModel() -> String {
    if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
    var info = utsname()
    uname(&info)
    return withUnsafePointer(to: &info.machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) { String(cString: $0) }
    }
  }

  func deviceProfileJSON() -> String {
    var abiSupported = false
    #if arch(arm64)
    abiSupported = true
    #else
    // Internal simulator builds on Intel hosts exercise the UI only (DEV-001).
    abiSupported = PlatformService.isSimulator && NamuBuildConfig.current.isInternalBuild
    #endif
    let profile: [String: Any] = [
      "physicalMemoryBytes": ProcessInfo.processInfo.physicalMemory, // DEV-002
      "logicalCpuCount": ProcessInfo.processInfo.processorCount,
      "freeDiskBytes": PlatformService.freeDiskBytes(),
      "osSupported": ProcessInfo.processInfo.isOperatingSystemAtLeast(
        OperatingSystemVersion(majorVersion: 17, minorVersion: 0, patchVersion: 0)),
      "abiSupported": abiSupported,
      "metalSupported": MTLCreateSystemDefaultDevice() != nil, // DEV-004
      "thermalApiAvailable": true,
    ]
    let data = (try? JSONSerialization.data(withJSONObject: profile)) ?? Data("{}".utf8)
    return String(decoding: data, as: UTF8.self)
  }

  static func freeDiskBytes() -> Int64 {
    let home = URL(fileURLWithPath: NSHomeDirectory())
    if let values = try? home.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
       let capacity = values.volumeAvailableCapacityForImportantUsage, capacity > 0 {
      return capacity
    }
    let attributes = try? FileManager.default.attributesOfFileSystem(forPath: home.path)
    return (attributes?[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
  }

  func thermalState() -> String {
    switch ProcessInfo.processInfo.thermalState {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    @unknown default: return "unknown"
    }
  }

  func availableMemoryBytes() -> Double {
    let available = os_proc_available_memory()
    if available > 0 { return Double(available) }
    // The simulator reports 0; estimate from host VM statistics so functional
    // UI runs are not blocked as MEMORY_LOW. Devices always take the path above.
    var stats = vm_statistics64()
    var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.stride / MemoryLayout<integer_t>.stride)
    let result = withUnsafeMutablePointer(to: &stats) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
      }
    }
    guard result == KERN_SUCCESS else { return Double(ProcessInfo.processInfo.physicalMemory) / 2 }
    var pageSize: vm_size_t = 0
    host_page_size(mach_host_self(), &pageSize)
    return Double(UInt64(stats.free_count + stats.inactive_count) * UInt64(pageSize))
  }

  func preferredLocales() -> [String] {
    Locale.preferredLanguages
  }

  /// DB-002: UUIDv4 from the system CSPRNG, lower case.
  func randomUUID() -> String {
    UUID().uuidString.lowercased()
  }

  // MARK: - Small OS services

  /// SEC-007: only ever called from an explicit user action in JS.
  func copyToClipboard(_ text: String) {
    DispatchQueue.main.async { UIPasteboard.general.string = text }
  }

  /// DS-004: explicit actions and terminal success/error only.
  func haptic(_ kind: String) {
    DispatchQueue.main.async {
      switch kind {
      case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
      case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
      default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
      }
    }
  }

  func isReduceMotionEnabled(_ completion: @escaping (Bool) -> Void) {
    DispatchQueue.main.async { completion(UIAccessibility.isReduceMotionEnabled) }
  }

  // MARK: - Chat data directory (SEC-001)

  static func chatDataDirectoryURL() -> URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("NamuData", isDirectory: true)
  }

  /// Creates `Library/Application Support/NamuData`, excluded from backup and
  /// protected with `FileProtectionType.complete`; returns its path.
  func prepareChatDataDirectory(at directory: URL = PlatformService.chatDataDirectoryURL()) throws -> String {
    let fm = FileManager.default
    do {
      try fm.createDirectory(
        at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
      // Re-assert on every start: attributes of an existing directory are not
      // touched by createDirectory.
      try? fm.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: directory.path)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      var mutable = directory
      try mutable.setResourceValues(values)
    } catch {
      throw NamuError(NamuError.storageWriteFailed, "chat data directory")
    }
    return directory.path
  }

  func chatDataSizeBytes(at directory: URL = PlatformService.chatDataDirectoryURL()) -> Double {
    PlatformService.directorySize(directory)
  }

  static func directorySize(_ directory: URL) -> Double {
    let keys: Set<URLResourceKey> = [.isRegularFileKey, .fileSizeKey]
    guard let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: Array(keys)) else {
      return 0
    }
    var total: Int64 = 0
    for case let file as URL in enumerator {
      guard let values = try? file.resourceValues(forKeys: keys), values.isRegularFile == true else { continue }
      total += Int64(values.fileSize ?? 0)
    }
    return Double(total)
  }

  /// SEC-006: removes the chat DB (with -wal/-shm), diagnostics and
  /// preference files. The caller guarantees the engine and DB are closed.
  func deleteChatData(at directory: URL = PlatformService.chatDataDirectoryURL()) throws {
    let fm = FileManager.default
    guard fm.fileExists(atPath: directory.path) else { return }
    do {
      try fm.removeItem(at: directory)
    } catch {
      throw NamuError(NamuError.storageWriteFailed, "delete chat data")
    }
  }
}
