package org.namuai.offline

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import org.namuai.offline.modules.NamuExportModule
import org.namuai.offline.modules.NamuPackage
import org.namuai.offline.platform.PlatformSignals
import org.namuai.offline.transfer.TransferRuntime

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Namu's own TurboModules live in the app, so they are registered by hand.
          add(NamuPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    // Native services first: the OS may start this process only to run a transfer job, with
    // no Activity and no JS runtime (ARC-003). Nothing below blocks the main thread.
    PlatformSignals.install(this) // thermal + memory pressure at Application level (INF-007)
    TransferRuntime.warmUp(this) // journal, startup reconciliation (contract §6.4)
    NamuExportModule.sweepOnStart(this) // SEC-005: exports older than 24 h

    loadReactNative(this)
  }
}
