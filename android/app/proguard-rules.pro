# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# Namu TurboModules are looked up by class name (ReactModuleInfo) and called through the
# codegen specs; keep them if minification is ever enabled.
-keep class org.namuai.offline.modules.** { *; }
-keep class org.namuai.offline.specs.** { *; }
# OS entry points named in the manifest.
-keep class org.namuai.offline.transfer.UidtTransferJobService { *; }
-keep class org.namuai.offline.transfer.TransferWorker { *; }
