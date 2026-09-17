# Toolchain lock (STK-001)

Recorded on 2026-09-17 on the bootstrap workstation. "Template" values come
from the exact React Native 0.86.0 template and its Gradle version catalog
(`node_modules/react-native/gradle/libs.versions.toml`); they are the versions
CI must install. Validate current store submission requirements (target SDK,
Xcode) again at release time (REL-004).

| Tool | Locked version | Source |
|---|---|---|
| React Native | 0.86.0 (New Architecture, Hermes) | package.json (exact) |
| React | 19.2.3 | RN 0.86.0 template |
| llama.rn | 0.12.9 — bundled llama.cpp b10256 (`BUILD_NUMBER 10256`, commit `6c8dcaa`) | package.json (exact), `node_modules/llama.rn/src/version.ts` |
| Runtime build ID | `llamarn-0.12.9-b10256` | `src/domain/inference/productionConfig.ts` |
| Node.js | 25.8.1 on the bootstrap machine; `engines.node >= 22.11.0`; CI uses 22 LTS | `node -v` |
| npm | 11.11.0 | `npm -v` |
| TypeScript | 5.9.3 (strict) | package.json (exact) |
| Xcode | 26.5 (17F42), iOS SDK 26.5 | `xcodebuild -version` |
| iOS deployment target | 17.0 | DEV-001 |
| CocoaPods | 1.16.2 (Ruby 2.6.10 system) | `pod --version` |
| macOS (bootstrap) | 26.6.2 (25G83), Intel x86_64 | `sw_vers` |
| JDK | **17 (Temurin) required** — not installed on the bootstrap machine (only OpenJDK 25.0.2, used for the standalone `android/namu-core` JVM tests) | RN 0.86 requirement |
| Gradle | 9.3.1 (wrapper) | `android/gradle/wrapper/gradle-wrapper.properties` |
| Android Gradle Plugin | 8.12.0 | RN version catalog |
| Kotlin | 2.1.20 | RN version catalog |
| Android compileSdk / targetSdk | 36 / 36 | RN template |
| Android minSdk | 29 (template default 24 overridden) | DEV-001 |
| Android build-tools | 36.0.0 | RN template |
| Android NDK | 27.1.12297006 | RN template |
| CMake (Android) | 3.30.5 | RN `ReactAndroid/build.gradle.kts` default |
| OkHttp | 4.9.2 (same as React Native) | RN version catalog |
| Python (release tools only) | 3.14.5; packages in `model-release/requirements.lock.txt` | `python3 --version` |
| fonttools / Pillow (asset tools) | 4.59.0 / 11.3.0 | `tools/fonts`, `tools/icons` |

## Locks committed

* `package-lock.json` — every direct dependency is pinned without `^`/`~`
  (enforced by `tests/arch/check-boundaries.js`).
* `ios/Podfile.lock`.
* `android/gradle/wrapper/*` (Gradle wrapper).
* llama.rn native artifact checksums (STK-003), verified by the package's
  install script before extraction and recorded here:
  * `llama-rn-android-jni-libs.tar.gz` — sha256 `cda945a7c0ed075a0b028c1c3c6f5b668532eb18b069ecc4793ed7ca6cdb65ac`
  * `llama-rn-ios-xcframework.tar.gz` — sha256 `ae9a37ae15a9e8d6ef0330f4afa3d8199af3590f7ecf371bfe48b35fd946c4ae`
  These are fetched at `npm ci` time on the build machine, never after app
  installation.

## Not yet locked (open M0 items)

* **Gradle dependency verification metadata** (`android/gradle/verification-metadata.xml`)
  must be generated with `./gradlew --write-verification-metadata sha256 help`
  on a machine with JDK 17 and the Android SDK. The bootstrap machine has
  neither (the SDK licence needs the owner's acceptance), so this file does not
  exist yet.
* The Android application module has not been compiled on the bootstrap
  machine for the same reason. See `docs/releases/v1/M0-foundation.md`.
