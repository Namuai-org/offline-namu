package org.namuai.offline.modules

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import org.namuai.offline.specs.NativeNamuExportSpec
import org.namuai.offline.specs.NativeNamuPlatformSpec
import org.namuai.offline.specs.NativeNamuTransferSpec

/** Registers the three Namu TurboModules (codegen library `NamuNativeSpec`). */
class NamuPackage : BaseReactPackage() {

    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? = when (name) {
        NativeNamuPlatformSpec.NAME -> NamuPlatformModule(reactContext)
        NativeNamuTransferSpec.NAME -> NamuTransferModule(reactContext)
        NativeNamuExportSpec.NAME -> NamuExportModule(reactContext)
        else -> null
    }

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
        listOf(
            NativeNamuPlatformSpec.NAME to NamuPlatformModule::class.java,
            NativeNamuTransferSpec.NAME to NamuTransferModule::class.java,
            NativeNamuExportSpec.NAME to NamuExportModule::class.java,
        ).associate { (name, type) ->
            name to ReactModuleInfo(
                name,
                type.name,
                false, // canOverrideExistingModule
                false, // needsEagerInit
                false, // isCxxModule
                true, // isTurboModule
            )
        }
    }
}
