import UIKit

/// SEC-007: hides chat content in the app-switcher preview. An opaque window
/// in the app background colour sits above everything (including presented
/// sheets) between `willResignActive` and `didBecomeActive`.
final class PrivacyCover {
  private var coverWindow: UIWindow?
  private var observers = [NSObjectProtocol]()

  /// Namu background token: #FAF9F6 light / #151715 dark (PRD §14).
  static let backgroundColor = UIColor { traits in
    traits.userInterfaceStyle == .dark
      ? UIColor(red: 0x15 / 255.0, green: 0x17 / 255.0, blue: 0x15 / 255.0, alpha: 1)
      : UIColor(red: 0xFA / 255.0, green: 0xF9 / 255.0, blue: 0xF6 / 255.0, alpha: 1)
  }

  func install(over window: @escaping () -> UIWindow?) {
    let center = NotificationCenter.default
    observers.append(center.addObserver(
      forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.show(over: window()) })
    observers.append(center.addObserver(
      forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.hide() })
  }

  private func show(over window: UIWindow?) {
    guard coverWindow == nil else { return }
    let cover: UIWindow
    if let scene = window?.windowScene {
      cover = UIWindow(windowScene: scene)
    } else {
      cover = UIWindow(frame: UIScreen.main.bounds)
    }
    let controller = UIViewController()
    controller.view.backgroundColor = PrivacyCover.backgroundColor
    controller.view.isOpaque = true
    cover.rootViewController = controller
    cover.backgroundColor = PrivacyCover.backgroundColor
    cover.windowLevel = .alert + 1
    cover.isUserInteractionEnabled = false
    cover.accessibilityElementsHidden = true
    cover.isHidden = false // shown without becoming key: focus and first responder stay put
    coverWindow = cover
  }

  private func hide() {
    coverWindow?.isHidden = true
    coverWindow = nil
  }
}
