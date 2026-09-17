# Android native layer — engineering notes

Scope: everything under `android/`. Binding inputs: the PRD (sections 2, 3, 7,
8, 16, 17, 20) and `docs/engineering/native-contract.md`. This file records how
the Android side is built, how it is verified, where it deviates from the
contract and what has **not** been verified yet.

## 1. Layout

```
android/
  namu-core/        standalone pure Kotlin/JVM Gradle build — all logic, JVM unit tests
  app/              React Native app module — thin Android glue over namu-core
  typecheck/        SDK-less compile check of app/ (not part of the app build)
  scripts/check-16kb-alignment.sh
```

### 1.1 `namu-core` (no Android imports)

Package `org.namuai.offline.core`:

| Package | Content | Requirements |
|---|---|---|
| `json` | `StrictJson` (duplicate-key rejecting, depth 16, exact integers), `JsonOut` | SIG-003, contract §4.1 |
| `descriptor` | `DescriptorVerifier` (same order as `model-release/descriptor/verify.mjs`), `Ed25519Verifier` seam + `TinkEd25519Verifier`, `TrustBundle` | SIG-001…005, contract §4 |
| `gguf` | `GgufCheck` bounded header reader (port of `model-release/dev/gguf-header.mjs`), `GgufInspector` seam | DL-010, contract §6.4 step 3 |
| `hash` | `Sha256Streamer` (8 MiB buffer, progress, cancellable, never serialized) | DL-004 |
| `transfer` | `TransferEngine` (OkHttp state machine), `ResponseRules` (pure 200/206/416 table), `RetryPolicy`, `SpaceRule`, `NetworkRule`, `Journal` + `InMemoryJournal` + `SqlJournal` over a `SqlDriver` seam, `TransferService` (DL-001 facade, snapshot JSON, update check, self-test/activation, retention, removal) | DL-001…DL-015, contract §5, §6 |
| `store` | `StorageLayout`, `DurableFiles` (tmp → `force(true)` → atomic move → directory fsync, crash checkpoints), `ActivePointerStore`, `ModelStore` (install, marker, activation, reconciliation, retention, quarantine) | DL-008, DL-012…DL-014, contract §3, §6.4 |
| `export` | `Exporter`, `ExportStore`, `ExportLabels`, `ExportText` over a `ReadOnlyDb` seam | SEC-004, SEC-005, contract §7 |
| `util` | `Clock`, `CrashHook`, `Coalescer` (≥ 250 ms snapshots) | DL-001 |

Injected seams (all faked in tests): `Clock`, `Sleeper`, `NetworkPolicy`,
`SpaceProbe`, `DeviceEligibility`, `TransferScheduler`, `TrustSource`,
`Ed25519Verifier`, `GgufInspector`, `CrashHook`, `DirectorySyncer`, `SqlDriver`,
`ReadOnlyDb`.

### 1.2 How `app` consumes `namu-core` — and why

`android/app/build.gradle` adds `../namu-core/src/main/kotlin` to the app's
`main` source set. The app compiles the **same source files** with its own
Kotlin (2.1.20 from the React Native 0.86 template). It does not consume the
standalone build's jar, and `android/settings.gradle` is untouched.

Alternatives rejected:

* `includeBuild("namu-core")` + dependency substitution: the React Native build
  puts the Kotlin Gradle plugin on the root buildscript classpath while the
  standalone build applies it through `plugins {}`. In a composite build the
  plugin is then loaded twice in different class loaders (a known source of
  Kotlin build-service conflicts), and the RN settings plugin/autolinking is
  the part of the build most sensitive to additional included builds.
* a `:namu-core` subproject in the RN `settings.gradle`: one directory cannot
  carry two build files cleanly, and the RN settings plugin/autolinking is the
  part of the build most sensitive to extra projects.

To keep "verified on the JVM" equal to "what the app compiles", the standalone
build uses the same Kotlin **2.1.20** as the app (language/API level 2.1), and
`./gradlew compileKotlin -Pnamu.java8ApiCheck` compiles the main sources with
`-Xjdk-release=1.8`, so no Java 9+ class-library API (absent or partial on
Android API 29) can slip in. Tink is `compileOnly` in namu-core (JVM `tink` in
tests); the app supplies `tink-android` with the identical
`com.google.crypto.tink.subtle.Ed25519Verify`.

### 1.3 `app` glue (`android/app/src/main/java/org/namuai/offline/`)

| File | Role |
|---|---|
| `MainApplication.kt` | registers `NamuPackage`; installs `PlatformSignals`, warms `TransferRuntime`, sweeps exports — before React loads, so it also works when the OS starts the process only for a job (ARC-003) |
| `MainActivity.kt` | `FLAG_SECURE` (SEC-007), `super.onCreate(null)` (react-native-screens), Ctrl/Meta+Enter → `onSendShortcut` (A11Y-002; plain Enter untouched) |
| `transfer/TransferRuntime.kt` | process-wide composition root (journal, service, bus) |
| `transfer/AndroidSqlDriver.kt` | `SQLiteDatabase` with `OpenParams` WAL + `synchronous=FULL` behind `SqlDriver` |
| `transfer/AndroidSeams.kt` | `StatFsSpaceProbe`, `OsDirectorySyncer` (`Os.fsync` on the directory), `AssetTrustSource` |
| `transfer/AndroidNetworkPolicy.kt` | default-network callback → connected (INTERNET + VALIDATED) / metered |
| `transfer/AndroidTransferScheduler.kt` | API 34+: UIDT `JobInfo` (`setUserInitiated`, `setRequiredNetwork`, `NOT_METERED` unless consent, `setEstimatedNetworkBytes`); API 29–33: unique expedited WorkManager request |
| `transfer/UidtTransferJobService.kt` | `setNotification`, engine thread, `onStopJob` → graceful stop; `STOP_REASON_USER` = pause, no reschedule (D06) |
| `transfer/TransferWorker.kt` | `CoroutineWorker`, `setForeground(dataSync)`, cancellation → graceful stop |
| `transfer/NotificationHelper.kt`, `SnapshotBus.kt` | low-importance channel; coalesced fan-out to JS |
| `platform/*` | device profile, eligibility, thermal + `onTrimMemory` at Application level, chat data directory |
| `export/AndroidReadOnlyDb.kt` | exporter's own `OPEN_READONLY` connection |
| `modules/*` | `NamuPlatformModule`, `NamuTransferModule`, `NamuExportModule` (extend the codegen specs), `NamuPackage` (`BaseReactPackage`), promise rejection mapping |

## 2. Toolchain actually used

| Item | Value |
|---|---|
| JDK | Homebrew OpenJDK **25.0.2** (`JAVA_HOME=/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home`); no Temurin 17 download was needed |
| Gradle | **9.3.1** (wrapper copied from `android/` into `android/namu-core/`) |
| Kotlin (namu-core, typecheck) | Kotlin Gradle plugin **2.1.20** (same as the app), `jvmTarget = 17`, no `jvmToolchain`. 2.1.20 was tried first on JDK 25 and works, so no newer plugin is used (2.3.21 was also run green during development) |
| Kotlin (app) | 2.1.20 (RN 0.86 template) — unchanged |
| Test libraries | JUnit 5.14.4, kotlin-test, OkHttp MockWebServer 4.9.2, Tink 1.23.0 (JVM), sqlite-jdbc 3.53.4.0 (**test only**) |
| App dependencies (pinned) | okhttp 4.9.2 (= RN 0.86 `libs.versions.toml`), work-runtime-ktx 2.10.5, tink-android 1.23.0, kotlinx-coroutines-android 1.10.2, androidx.core 1.13.1 |

## 3. Commands

```bash
export JAVA_HOME=/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home

# Unit tests (212 tests, pure JVM; reads model-release/test-vectors/descriptor-vectors.json in place)
cd android/namu-core && ./gradlew test

# Java 8 class-library guard for code that must run on Android API 29
cd android/namu-core && ./gradlew compileKotlin -Pnamu.java8ApiCheck

# SDK-less compile check of android/app (main + androidTest) — needs `node` and node_modules
cd android/typecheck && ../namu-core/gradlew -p . compileKotlin compileJava

# On a machine WITH the Android SDK
node model-release/dev/make-dev-bundle.mjs --model <fixture.gguf>   # writes app/src/main/assets/namu/
cd android && ./gradlew :app:assembleDebug
cd android && ./gradlew :app:connectedDebugAndroidTest              # instrumented tests (NOT RUN yet)
cd android && ./gradlew :app:bundleRelease -PNAMU_MODEL_ORIGIN=https://<distribution-domain>
android/scripts/check-16kb-alignment.sh --release android/app/build/outputs/bundle/release/app-release.aab
android/scripts/check-16kb-alignment.sh android/app/build/outputs/apk/debug/app-debug.apk
```

Release gate (`verifyNamuReleaseConfig`, wired before `preReleaseBuild`): fails
unless `NAMU_MODEL_ORIGIN` is `https://…` without a trailing slash, the three
trust files exist in `app/src/main/assets/namu/`, and no `key_id` starts with
`dev-`. Trust files and copied fonts are git-ignored (`android/app/.gitignore`).

### 3.1 `typecheck/`

Compiles `app/src/main/java`, `app/src/androidTest/java` and namu-core against:
Robolectric's `android-all` (AOSP build, Apache 2.0, Maven Central — **not**
the Android SDK, no licence click-through), the published `react-android`
0.86.0 / WorkManager / androidx AARs (their `classes.jar`), and the codegen
Java specs generated by the same node scripts the RN Gradle plugin runs.
`BuildConfig`, `R`, `PackageList` and `ReactNativeApplicationEntryPoint` are
stubs. It proves names, signatures, overrides and nullability. It does **not**
prove resources, manifest merging, lint API-level checks, D8/packaging, the
Groovy build scripts, or runtime behaviour.

### 3.2 `check-16kb-alignment.sh` (DEV-005, T28)

Every `.so` in an APK/AAB: all `PT_LOAD` alignments ≥ `0x4000`
(llvm-readelf/readelf → llvm-objdump/objdump → built-in python3 ELF parser);
APK only: uncompressed `.so` entries on 16 KB ZIP boundaries
(`zipalign -c -P 16 -v 4` when available, else built-in check) and no
compressed `.so`; `--release`: only `arm64-v8a`. Exit 1 on any violation.
Verified here only against synthesized packages (good / bad ELF / bad ZIP
offset / compressed / extra ABI / AAB). A 16 KB emulator run is still required.

## 4. PRD test coverage in `namu-core`

| PRD test | Where |
|---|---|
| T03 drop at 10/50/99 %, resume; truncate-to-committed | `TransferEngineTest.t03_*` |
| T04 200 to Range | `TransferEngineTest.t04_*`, `ResponseRulesTest` |
| T05 wrong Content-Range / changed ETag / replaced object / truncated body | `TransferEngineTest.t05_*`, `ResponseRulesTest` |
| T06 416 complete vs incomplete | `ResponseRulesTest.rangeNotSatisfiable_T06`, `TransferEngineTest.t06_*` |
| T07 endless / oversized body, old model preserved | `TransferEngineTest.t07_*` |
| T08 all 41 shared descriptor vectors (file read in place), signature-before-parse, no GGUF parse before hash | `DescriptorVectorsTest`, `DescriptorVerifierTest`, `TransferEngineTest.t08_*` |
| T09 space before transfer / during transfer / before verification output / at activation, failing probe | `TransferEngineTest.t09_*` |
| T10 crash at **every** activation checkpoint (discovered dynamically, ×2 scenarios) → one valid pointer, deterministic recovery | `ActivationCrashTest` |
| T11 update staged while runtime holds a model | `TransferServiceTest.t11_*` |
| T23 export failure/low space leaves no partial file and an untouched DB | `ExporterTest.t23_*` |
| T29 same sequence altered payload, replay, expiry; model keeps working | `DescriptorVerifierTest`, `TransferServiceTest.t29_*` |
| T30 key rotation only through bundled keys | `DescriptorVerifierTest.keyRotation*` |
| DL-007 timing, DL-009 arithmetic, DL-001 coalescing, contract §5 SQL on real SQLite | `RetryPolicyTest`, `SpaceAndNetworkRuleTest`, `CoalescerTest`, `SqlJournalTest` |

## 5. Decisions and deviations from the contract

1. **Retry counting (DL-007).** All five back-off steps (2/5/15/30/60 s) are
   used. `retry_count` = automatic retries consumed; the transfer becomes
   `failed/TRANSFER_RETRY` when a failure arrives after the fifth retry
   (i.e. the sixth consecutive failed attempt). Reading "five failures" as
   "stop after the fifth failure" would make the 60 s step unreachable.
2. **Jitter** is additive only (+0…20 %), as the contract says "up to +20 %".
   `Retry-After` larger than 15 min is capped to 15 min, never ignored.
3. **Restart bound.** At most 3 restart-from-zero events per engine run, then
   `failed/TRANSFER_RETRY` with staging removed. Not in the contract; it stops
   a server that keeps invalidating resumes from consuming unbounded data.
4. **416 with a complete file** cannot occur on Android: when
   `committed_bytes == expected_bytes` the engine verifies without a request.
   The 416 rule itself is implemented and unit-tested in `ResponseRules`.
5. **`Content-Length` ≠ signed size on a 200** → `failed/FILE_DAMAGED` (the
   origin does not hold the signed object). **Off-origin / >3 redirects,
   non-identity `Content-Encoding`, other 4xx** → `failed/TRANSFER_RETRY`
   without automatic retry.
6. **`retryOnConnectionFailure` stays true** (OkHttp default). With `false`
   OkHttp does not try the next resolved address (IPv6 → IPv4), which broke
   even loopback tests. It never follows redirects and never repeats a request
   whose response has started.
7. **Pending marker has one extra field**, `selfTestPassed`. `activate(pass)`
   rewrites the marker durably before replacing the pointer. Recovery: marker +
   pointer already switched → finish the journal commit; marker says passed but
   pointer not switched → candidate stays `staged` (not quarantined); marker
   without pass → quarantine + `failed/MODEL_LOAD_FAILED` as the contract says.
   Without this, a crash inside the short activation window would mark a good
   artifact locally bad forever.
8. **Space failure at activation**: marker removed, phase back to `staged`
   with `SPACE_LOW`, promise rejected with `SPACE_LOW`; the old pointer is
   untouched and the same candidate can be activated later.
9. **`beginSelfTest` rejects with `ENGINE_BUSY`** while the runtime reference
   names another artifact (DL-011, T11). **`restorePrevious` and `repair`**
   also reject with `ENGINE_BUSY` while any runtime reference is set.
10. **One live transfer at a time**: `start` for another artifact is
    `INVALID_STATE` while a non-installed, non-failed transfer exists; failed
    leftovers of other artifacts are cleaned up. `start` on a failed transfer
    of the same artifact is the user retry. `cancel` of an unknown ID resolves
    (idempotent); `pause`/`resume` of an unknown ID reject `NOT_FOUND`.
11. **Native eligibility gate**: `start` rejects `DEVICE_INELIGIBLE` below
    5,000,000,000 bytes of RAM or without arm64-v8a. Internal builds on an
    emulator are exempt (RAM) and accept x86_64, so the fixture pipeline works.
12. **`checkForUpdate` may use a metered network** (≤ 64 KiB, explicit user
    action). Model bytes never do without per-transfer consent.
13. **Memory pressure mapping** excludes `TRIM_MEMORY_UI_HIDDEN` (20): it is
    numerically ≥ `RUNNING_LOW` but only means "UI hidden". `RUNNING_LOW`,
    `BACKGROUND`, `MODERATE` → `warning`; `RUNNING_CRITICAL`, `COMPLETE`,
    `onLowMemory` → `critical`.
14. **Haptics use `View.performHapticFeedback` only** (CONFIRM/REJECT on API
    30+). `VibrationEffect` would need the `VIBRATE` permission, which is not in
    the required manifest list.
15. **Export read transaction.** `android.database.sqlite` has no read-only
    transaction before API 35: `beginTransaction*` are write transactions (a
    read-only connection refuses them), a literal `BEGIN` via `execSQL`/`rawQuery`
    is rewritten into an exclusive transaction by `SQLiteSession`, and a
    long-lived `Cursor` re-executes its statement on every window refill, so it
    is not a snapshot either. API 35+: `beginTransactionReadOnly()` = one
    deferred read transaction, exactly the contract. API 29–34: single read-only
    connection (no WAL pool) + `PRAGMA data_version` before/after; if another
    connection committed meanwhile the partial export is deleted and repeated
    (max 3), then `ENGINE_BUSY`. A successful export is always a consistent
    snapshot; exporting while an answer streams may need a retry on API ≤ 34.
16. **`share` resolves `true` once the chooser was launched** (`false` when
    nothing could be launched). Android gives no completion/cancel signal. The
    file stays until `deleteExport` or the 24 h sweep (run at every process start).
17. **Strict JSON rejects a UTF-8 BOM**; the Node reference (`TextDecoder`)
    strips it. **Timestamps reject `24:00:00`**; `Date.parse` accepts it. Both
    are stricter, none of the shared vectors is affected.
18. **Backup**: `allowBackup="false"` **and** both rule files excluding every
    domain for cloud backup and device transfer (Android 12+ device transfer
    ignores `allowBackup`).
19. **Foreground start refusal (API 31–33)**: if `setForeground` is refused
    because the worker started in the background, the worker continues inside
    the normal execution window; a system stop costs only a retry.
20. **Notification strings** exist in English and French. Hausa needs the
    human review LOC-002 demands; until then Hausa devices see English.

## 6. NOT verified in this environment (no Android SDK, no device)

Compile-checked only through `android/typecheck` (framework API 35 jar, not a
real AGP build), never executed:

* every Kotlin file under `android/app/src/main/java/` and
  `android/app/src/androidTest/java/`

Not even compile-checked:

* `android/app/build.gradle`, `android/build.gradle`, `android/gradle.properties`
  (Groovy/AGP DSL: `androidComponents.onVariants … packaging.jniLibs.excludes`,
  `verifyNamuReleaseConfig`, `copyNamuFonts`, source-dir inclusion)
* `AndroidManifest.xml`, `res/xml/*.xml`, `res/values*/*.xml`, debug network
  security config, `proguard-rules.pro`
* app-level codegen + C++ TurboModule provider linking (`NamuNativeSpec`) in the
  real RN build
* API-level lint, R8, packaging, 16 KB check on a real APK/AAB
* instrumented tests (`SqliteJournalInstrumentedTest`,
  `BackgroundEntryPointsInstrumentedTest`) — written, **NOT RUN**
* UIDT / WorkManager behaviour on devices, OEM backup behaviour (T27), T28

Also open: Gradle dependency verification metadata (STK-001) must be generated
on a machine that can resolve the full Android build.

## 7. Needed from the JS side

* Call order for an update: `setRuntimeReference('')` after unload →
  `beginSelfTest` → load candidate via `resolveArtifactPath` →
  `setRuntimeReference(candidate)` → `activate`. `removeModel`,
  `deleteAllTransferData`, `restorePrevious`, `repair` need an empty reference.
* There is no JS API for the *automatic* failed-trial restore (contract §6.4
  "marks the abandoned digest bad only when invoked automatically"). Native has
  `TransferService.restorePrevious(markAbandonedBad = true)`; the spec exposes
  only the manual variant. Add a spec method or a parameter if JS must trigger it.
* A digest quarantined after a crashed self-test stays bad until
  `deleteAllTransferData()`. With only the bundled artifact available that blocks
  reinstall on that device — a product decision for the repair UI.
* The chat schema must stay readable by the **system** SQLite of API 29
  (3.22): no `STRICT` tables, generated columns or other post-3.22 schema
  features in tables the exporter reads (`conversations`, `turns`,
  `assistant_attempts`). FTS5 virtual tables are fine (never touched natively).
* `ExportLabels` must keep the keys `created, updated, responseLanguage,
  languageNames, you, namu, interrupted, lengthLimited, untitled`.
* `ENGINE_BUSY` from an export on API ≤ 34 means "database changed during the
  export three times" — offer retry once the answer has finished.
* Debug builds allow cleartext only to `10.0.2.2`, `localhost`, `127.0.0.1`
  (Metro over LAN IP needs `adb reverse`).
