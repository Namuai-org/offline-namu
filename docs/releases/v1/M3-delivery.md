# M3 — Model delivery

**Built**
* Signed descriptor tooling (`model-release/descriptor/`), 41 shared
  conformance vectors, development trust bundle, publication pipeline and
  runbooks (`docs/runbooks/model-publication.md`, `signing-keys.md`).
* Terraform for private S3 + CloudFront (OAC), staging and production, alarms,
  budget, 7-day logs, least-privilege publisher role (`infra/`).
* Android: `android/namu-core` (transfer engine, response rules, retry policy,
  journal, verifier, GGUF check, durable active pointer, retention, exporter)
  and app glue (UIDT JobService on API 34+, WorkManager on 29–33).
* iOS: background `URLSession` service with persisted resume data, journal,
  verifier (CryptoKit), pointer, retention, reconciliation.
* Fault-injection server (`tools/fault-server/`).

**Verified**

| Evidence | Result |
|---|---|
| `node --test model-release/ tools/fault-server/` | 118 tests pass (strict JSON, all vectors, sign→verify, publication checks against the fault server, fault recipes) |
| `cd android/namu-core && ./gradlew test` (JDK 25, Kotlin 2.1.20) | **212 tests pass**: T03 (drop at 10/50/99 %), T04, T05, T06, T07, T08 (all vectors + no GGUF parse before hash), T09 (space probe), T10 (crash at each of 18 activation checkpoints → exactly one valid pointer), T11, T23, T29, T30 |
| iOS `xcodebuild test` on the simulator | **94 tests pass**, incl. a real background `URLSession` against an in-process server: full install, T07, T08, GGUF/architecture failures, 404/503 back-off, pause and honest restart, update check and replay, both `restorePrevious` modes; T10 at 6 checkpoints |
| iOS simulator, end to end, against the fault server | bundled signed descriptor verified → one GET of the artifact (server log) → exact length → SHA-256 → GGUF check → staged → foreground self-test → atomic activation → installed; state survived an app restart. No request to `releases/stable.json` without a user action (SIG-005) |

**Open**
* Terraform has never been validated or applied (`terraform` is not installed);
  no bucket, distribution, hostname or production key exists.
* Android transfer glue has never run on a device or emulator.
* T03–T12 on physical devices, T12 (iOS force-quit), real CloudFront range
  behaviour (D09), 24-hour paused transfer, low-storage on a full disk.
* Deviations from the contract are listed in
  `docs/engineering/android-native-notes.md` and `ios-native-notes.md`
  (e.g. quarantined digests stay bad until all transfer data is deleted — a
  product decision for the repair UI).
