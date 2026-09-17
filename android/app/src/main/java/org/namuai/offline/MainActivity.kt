package org.namuai.offline

import android.os.Bundle
import android.view.KeyEvent
import android.view.WindowManager
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import org.namuai.offline.platform.PlatformSignals

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "Namu"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    // SEC-007: chat content never appears in the app-switcher preview or in screenshots.
    window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    // react-native-screens requires a null state: its fragments are never restored by the system.
    super.onCreate(null)
  }

  private var sendShortcutArmed = false

  /**
   * A11Y-002: hardware Ctrl+Enter (or Meta/Cmd+Enter) sends. Both halves of the key press are
   * consumed so the composer never receives a newline; the event is emitted once, on ACTION_UP,
   * even when the modifier was released first. A plain Enter is NOT intercepted: it inserts a
   * newline.
   */
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val isEnter = event.keyCode == KeyEvent.KEYCODE_ENTER || event.keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER
    if (isEnter) {
      val withModifier = event.isCtrlPressed || event.isMetaPressed
      if (event.action == KeyEvent.ACTION_DOWN && withModifier) {
        sendShortcutArmed = true
        return true
      }
      if (event.action == KeyEvent.ACTION_UP && (sendShortcutArmed || withModifier)) {
        sendShortcutArmed = false
        PlatformSignals.sendShortcut()
        return true
      }
    }
    return super.dispatchKeyEvent(event)
  }
}
