import UIKit
import XCTest
@testable import Namu

/// Contract §2.
final class PlatformServiceTests: XCTestCase {
  private var directory: URL!
  private let service = PlatformService.shared

  override func setUpWithError() throws { directory = try TestSupport.makeTemporaryDirectory("platform") }
  override func tearDown() { TestSupport.remove(directory) }

  func testDeviceProfileShape() throws {
    let profile = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(service.deviceProfileJSON().utf8)) as? [String: Any])
    XCTAssertEqual(Set(profile.keys), [
      "physicalMemoryBytes", "logicalCpuCount", "freeDiskBytes", "osSupported", "abiSupported",
      "metalSupported", "thermalApiAvailable",
    ])
    XCTAssertGreaterThan((profile["physicalMemoryBytes"] as? NSNumber)?.int64Value ?? 0, 0)
    XCTAssertGreaterThan(profile["logicalCpuCount"] as? Int ?? 0, 0)
    XCTAssertGreaterThan((profile["freeDiskBytes"] as? NSNumber)?.int64Value ?? 0, 0)
    XCTAssertEqual(profile["osSupported"] as? Bool, true)
    XCTAssertEqual(profile["thermalApiAvailable"] as? Bool, true)
  }

  func testConstants() {
    let constants = service.constants()
    XCTAssertEqual(constants.osName, "iOS")
    XCTAssertFalse(constants.osVersion.isEmpty)
    XCTAssertFalse(constants.deviceModel.isEmpty)
    XCTAssertTrue(constants.isSimulator)
    // The test host is the Debug build: org.namuai.offline.internal (STK-004).
    XCTAssertTrue(constants.isInternalBuild)
    XCTAssertEqual(Bundle.main.bundleIdentifier, "org.namuai.offline.internal")
    XCTAssertGreaterThanOrEqual(constants.appBuild, 1)
  }

  func testBuildConfigurationOfTheDebugHost() {
    let config = NamuBuildConfig.load()
    XCTAssertEqual(config.runtimeBuildId, "llamarn-0.12.9-b10256")
    XCTAssertEqual(config.modelOrigin, "http://localhost:8787")
    XCTAssertEqual(config.profile, .internalFixture)
    let ats = Bundle.main.object(forInfoDictionaryKey: "NSAppTransportSecurity") as? [String: Any]
    XCTAssertEqual(ats?["NSAllowsArbitraryLoads"] as? Bool, false)
    XCTAssertNil(ats?["NSAllowsLocalNetworking"])
    XCTAssertEqual(Array(((ats?["NSExceptionDomains"] as? [String: Any]) ?? [:]).keys), ["localhost"])
    for font in ["DMSans-Regular", "DMSans-Medium", "DMSans-SemiBold", "MaterialSymbolsRounded-Subset"] {
      XCTAssertNotNil(Bundle.main.url(forResource: font, withExtension: "ttf"), font)
    }
    XCTAssertNotNil(Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"))
  }

  func testRandomUUIDIsLowercaseVersion4() {
    var seen = Set<String>()
    for _ in 0..<200 {
      let value = service.randomUUID()
      XCTAssertEqual(value, value.lowercased())
      let characters = Array(value)
      XCTAssertEqual(characters.count, 36)
      XCTAssertEqual(characters[14], "4", "version nibble")
      XCTAssertTrue("89ab".contains(characters[19]), "variant nibble")
      seen.insert(value)
    }
    XCTAssertEqual(seen.count, 200)
  }

  func testThermalStateAndLocales() {
    XCTAssertTrue(["nominal", "fair", "serious", "critical", "unknown"].contains(service.thermalState()))
    XCTAssertFalse(service.preferredLocales().isEmpty)
    XCTAssertGreaterThan(service.availableMemoryBytes(), 0, "never reports 0 (the simulator has no os_proc_available_memory)")
  }

  func testChatDataDirectoryLifecycle() throws {
    let target = directory.appendingPathComponent("NamuData", isDirectory: true)
    let path = try service.prepareChatDataDirectory(at: target)
    XCTAssertEqual(path, target.path)
    XCTAssertEqual(try target.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    XCTAssertEqual(try service.prepareChatDataDirectory(at: target), target.path, "idempotent")

    try Data(count: 1000).write(to: target.appendingPathComponent("namu.sqlite"))
    try Data(count: 234).write(to: target.appendingPathComponent("namu.sqlite-wal"))
    try FileManager.default.createDirectory(at: target.appendingPathComponent("diagnostics"), withIntermediateDirectories: true)
    try Data(count: 5).write(to: target.appendingPathComponent("diagnostics/ring.bin"))
    XCTAssertEqual(service.chatDataSizeBytes(at: target), 1239)

    try service.deleteChatData(at: target)
    XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
    XCTAssertNoThrow(try service.deleteChatData(at: target), "deleting twice is fine")
    XCTAssertEqual(service.chatDataSizeBytes(at: target), 0)
  }

  func testMemoryWarningReachesListenersWithoutAnyReactView() {
    service.start()
    let received = expectation(description: "memory event")
    let token = service.addMemoryListener { level in
      if level == "critical" { received.fulfill() }
    }
    defer { service.removeListener(token) }
    NotificationCenter.default.post(name: UIApplication.didReceiveMemoryWarningNotification, object: UIApplication.shared)
    wait(for: [received], timeout: 5)
  }

  /// A11Y-002: only Cmd+Return is registered; a plain Return is never intercepted.
  func testSendShortcutIsCommandReturnOnly() throws {
    let delegate = try XCTUnwrap(UIApplication.shared.delegate as? AppDelegate)
    let commands = try XCTUnwrap(delegate.keyCommands)
    XCTAssertEqual(commands.count, 1)
    let command = try XCTUnwrap(commands.first)
    XCTAssertEqual(command.input, "\r")
    XCTAssertEqual(command.modifierFlags, .command)
    XCTAssertTrue(command.wantsPriorityOverSystemBehavior)
    XCTAssertFalse(commands.contains { $0.input == "\r" && $0.modifierFlags.isEmpty })

    let received = expectation(description: "send shortcut")
    let token = service.addSendShortcutListener { source in
      XCTAssertEqual(source, "hardware-keyboard")
      received.fulfill()
    }
    defer { service.removeListener(token) }
    let action = try XCTUnwrap(command.action)
    XCTAssertTrue(delegate.responds(to: action))
    XCTAssertTrue(UIApplication.shared.next === delegate, "the app delegate closes the responder chain")

    // Simulate the composer: a focused multiline text view deep in the window.
    let window = try XCTUnwrap(delegate.window)
    let composer = UITextView(frame: CGRect(x: 0, y: 0, width: 200, height: 80))
    composer.inputView = UIView() // no software keyboard: keeps the test fast
    window.rootViewController?.view.addSubview(composer)
    defer { composer.removeFromSuperview() }
    XCTAssertTrue(composer.becomeFirstResponder())
    XCTAssertTrue(composer.target(forAction: action, withSender: command) as AnyObject? === delegate,
                  "the responder chain resolves Cmd+Return to the app delegate")
    XCTAssertTrue(UIApplication.shared.sendAction(action, to: nil, from: command, for: nil))
    wait(for: [received], timeout: 5)
    XCTAssertEqual(composer.text, "", "the shortcut never edits the draft")
  }

  func testPrivacyCoverUsesNamuBackgroundTokens() {
    func hex(_ style: UIUserInterfaceStyle) -> String {
      let color = PrivacyCover.backgroundColor.resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
      var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
      color.getRed(&r, green: &g, blue: &b, alpha: &a)
      XCTAssertEqual(a, 1)
      return String(format: "#%02X%02X%02X", Int(round(r * 255)), Int(round(g * 255)), Int(round(b * 255)))
    }
    XCTAssertEqual(hex(.light), "#FAF9F6")
    XCTAssertEqual(hex(.dark), "#151715")
  }
}
