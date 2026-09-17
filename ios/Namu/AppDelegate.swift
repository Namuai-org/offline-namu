import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?
  private let privacyCover = PrivacyCover()

  /// Hosted unit tests exercise the native services directly; they need
  /// neither React Native nor the background transfer session.
  private var isRunningUnitTests: Bool {
    ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
  }

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    window = UIWindow(frame: UIScreen.main.bounds)
    window?.backgroundColor = PrivacyCover.backgroundColor

    if isRunningUnitTests {
      window?.rootViewController = UIViewController()
      window?.makeKeyAndVisible()
      return true
    }

    // ARC-003: native services start before (and independently of) React, so
    // background URLSession events are handled even when no JS runtime exists.
    TransferService.shared.start()
    PlatformService.shared.start()
    ExportService.shared.sweepExports { _ in } // SEC-005: 24 h sweep on every start
    privacyCover.install(over: { [weak self] in self?.window }) // SEC-007

    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    factory.startReactNative(
      withModuleName: "Namu",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }

  /// DL-005: the OS relaunches or wakes the app for background transfer
  /// events. The handler is stored and invoked once the session delegate has
  /// drained its events (`urlSessionDidFinishEvents`).
  func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    TransferService.shared.handleBackgroundEvents(identifier: identifier, completionHandler: completionHandler)
  }

  // A11Y-002: hardware Cmd+Return sends. The app delegate is the last
  // responder in the chain, so this works whichever React view has focus.
  // Only the Command-modified key is registered: a plain Return is never
  // intercepted and keeps inserting a newline in the composer.
  override var keyCommands: [UIKeyCommand]? {
    let send = UIKeyCommand(input: "\r", modifierFlags: .command, action: #selector(handleSendShortcut(_:)))
    send.wantsPriorityOverSystemBehavior = true // the focused text view must not swallow it
    return [send]
  }

  @objc private func handleSendShortcut(_ command: UIKeyCommand) {
    PlatformService.shared.emitSendShortcut()
  }

  // DEV-006: portrait and landscape on phones; all orientations on iPad.
  func application(
    _ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?
  ) -> UIInterfaceOrientationMask {
    UIDevice.current.userInterfaceIdiom == .pad ? .all : .allButUpsideDown
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  /// The root view is white until the first React frame; keep the brand field
  /// (Harmattan / Ink) so launch screen, loading and app are one surface.
  override func customize(_ rootView: RCTRootView) {
    super.customize(rootView)
    rootView.backgroundColor = PrivacyCover.backgroundColor
  }

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
