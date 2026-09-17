# iOS native layer notes

Companion to `native-contract.md`. Everything here lives under `ios/`.

## Layout

| Path | Purpose |
|---|---|
| `ios/scripts/configure_project.rb` (`.sh` wrapper) | Reproducible pbxproj edits through the `xcodeproj` gem that ships with CocoaPods. Idempotent; re-run after adding files to `ios/Namu/Native` or `ios/NamuTests`, then `pod install`. |
| `ios/scripts/release_guards.sh` | Release-only build phase: `NAMU_MODEL_ORIGIN` must be `https://host`, `release-keys.json` must exist and contain no `dev-` key. |
| `ios/scripts/copy_trust_config.sh` | Copies `ios/Namu/NamuConfig/{initial-descriptor,release-keys,known-bad}.json` into the bundle. Debug tolerates absence, Release fails. |
| `ios/scripts/debug_ats_localhost.sh` | Debug-only: adds an ATS exception for `localhost` to the *built* Info.plist. The checked-in plist allows no insecure loads. |
| `ios/Namu/Native/*.swift` | Services (see below). |
| `ios/Namu/Native/Namu*Module.{h,mm}` | TurboModule shims; forward to Swift through `Namu-Swift.h`. |
| `ios/NamuTests/` | Hosted XCTest unit tests (`@testable import Namu`). |

## Build configuration

* Debug = internal build: bundle id `org.namuai.offline.internal`,
  `NAMU_MODEL_ORIGIN=http://localhost:8787`, fixture descriptor profile, dev
  keys accepted. `isInternalBuild` is derived from the `.internal` bundle-id
  suffix at run time.
* Release: bundle id `org.namuai.offline`. `NAMU_MODEL_ORIGIN` is intentionally
  **unset** in the project; supply it from the release environment:
  `xcodebuild … -configuration Release NAMU_MODEL_ORIGIN=https://<distribution-domain>`.
  The build fails without it, with a non-https value, with a trailing path,
  without the three trust files, or with a `dev-` key. At run time a Release
  build additionally ignores `dev-` keys and refuses any non-https origin.
* Physical-device Debug against Metro on the LAN needs
  `NAMU_DEBUG_ALLOW_LOCAL_NETWORKING=YES` (adds `NSAllowsLocalNetworking` to the
  Debug plist only). Default is `NO`: cleartext is limited to `localhost`.
* Fonts are referenced in place from `src/design/fonts`; the descriptor test
  vectors from `model-release/test-vectors`. Nothing is copied into `ios/`.

## Services

* `TransferService` is created by `AppDelegate` before React Native starts and
  owns one background `URLSession` (`<bundleId>.model-transfer`). All state is
  confined to one serial queue, which is also the session delegate queue.
* The metered policy (DL-006) lives in the **session configuration**
  (`allowsCellularAccess` / `allowsExpensiveNetworkAccess`). When a resume
  changes consent, the running task is cancelled with resume data, the session
  is invalidated and recreated with the new policy, and the transfer continues
  from the opaque resume data. Resume data is stored and replayed, never parsed.
* Retries (DL-007) are scheduled with `URLSessionTask.earliestBeginDate`, so the
  OS performs them even while the app is suspended. Back-off 2/5/15/30/60 s
  (+≤20 %), `Retry-After` ≤ 15 min; the failure of the fifth automatic retry
  becomes `failed/TRANSFER_RETRY`.
* A task that disappeared while the app was dead (force-quit, T12) becomes
  `failed/TRANSFER_RETRY` with whatever resume data the OS handed back. Nothing
  restarts silently; `resume` (or `start`) continues, and sets
  `restartedFromZero` when no resume data is usable.
* Background sessions follow redirects without consulting the delegate, so in
  addition to `willPerformHTTPRedirection` the final response URL is checked
  against `MODEL_ORIGIN` on the first progress callback and again on completion.
* Oversize protection: the task is cancelled when `totalBytesExpectedToWrite`
  or `totalBytesWritten` exceeds the signed length → `failed/FILE_DAMAGED`.
* Verification runs on a utility queue inside a UIKit background task: exact
  length → streaming SHA-256 → bounded GGUF check → `rename(2)` into
  `releases/<sha256>/model.gguf` (0444) → directory fsync.
* `ActivePointer.swift` holds the durable-write primitive (temp → `F_FULLFSYNC`
  → `rename` → directory fsync) with `DurableFile.crashHook` for T10.

## Known deviations / open points

* The all-conversations ZIP is produced by `NSFileCoordinator(.forUploading)`,
  which wraps the tree in a top-level folder: entries are
  `namu-export-<stamp>/conversations/…` and `namu-export-<stamp>/index.json`.
* `snapshot.transfer` is the newest journal row (any phase). After a successful
  install it reports `phase: installed` until the row is removed.
* A `waiting` transfer reports `errorCode` `NETWORK_WAIT`, `SPACE_LOW` or
  `TRANSFER_RETRY` (back-off, with `nextRetryAt`).
* There is no JS entry point for "trial failed" (DL-013 automatic rollback).
  `ModelStore.restorePrevious(mode: .failedTrial)` exists and is tested, but
  `restorePrevious()` from JS is always the user-initiated swap.
* An interrupted self-test marks the candidate digest locally bad (DL-012).
  Only `deleteAllTransferData` or an app update with another artifact clears
  that; re-downloading the same digest is refused with `FILE_DAMAGED`.

## Running the tests

```
cd ios && LANG=en_US.UTF-8 pod install
xcodebuild test -workspace Namu.xcworkspace -scheme Namu \
  -destination 'platform=iOS Simulator,name=NamuTest'
```

Under XCTest the AppDelegate skips React Native and the transfer service, so the
hosted tests are hermetic (no Metro, no background session).

Xcode 26.5 with only the iOS 26.4 simulator runtime installed offers no
simulator destinations until the SDK is mapped to that runtime:
`xcrun simctl runtime match set iphoneos26.5 <runtime build>` (undo with
`--default`). Installing the matching iOS 26.5 platform makes this unnecessary.
