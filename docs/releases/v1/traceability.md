# Requirements traceability (IMP-002)

Every requirement ID → implementation path → verification. "Verification"
names the automated suite or test ID from PRD section 20; the *result* of each
suite is recorded in the milestone evidence files next to this document.
`JS` = Jest (`tests/`), `JVM` = `android/namu-core` tests, `XCT` = `ios/NamuTests`,
`node` = `node --test` suites, `device` = needs physical hardware (not run).

Abbreviations: `core/` = `android/namu-core/src/main/kotlin/org/namuai/offline/core/`,
`app/` = `android/app/src/main/java/org/namuai/offline/`, `iOS/` = `ios/Namu/Native/`.

## 1. Product contract

| ID | Implementation | Verification |
|---|---|---|
| PRD-001 | whole app; no network on the chat path (`tests/arch/check-boundaries.js`) | JS `ui/chatJourney` (T02), device T02 |
| PRD-002 | `src/features/settings/SettingsScreen.tsx` (no tuning controls), `src/domain/inference/productionConfig.ts` | JS `ui/chatJourney` "Settings" |
| PRD-003 | `src/features/chat`, `src/features/conversations`, `useExport.tsx` | JS `ui/chatJourney` |
| PRD-004 | `src/locales/{en,fr,ha}.json`, `review-status.json` | `npm run check:locales`; human review **open** |
| PRD-005 | no screens exist for excluded features | review; `check:arch` dependency deny-list |
| PRD-006 | `src/features/about/AboutAiScreen.tsx` | JS (About strings), manual |
| PRD-007 | `model-release/acquire.py` header, `docs/releases/v1/M0-foundation.md` | owner evidence **open** |

## 2–3. Stack and device policy

| ID | Implementation | Verification |
|---|---|---|
| STK-001 | `package.json` exact pins, `package-lock.json`, `ios/Podfile.lock`, `docs/toolchain.lock.md` | `check:arch` (pin rule); Gradle verification metadata **open** |
| STK-002 | `llama.rn@0.12.9`; `EXPECTED_LLAMA_CPP_BUILD` in `LlamaRnEngine.ts` | `check:arch`; device M1 **open** |
| STK-003 | llama.rn install-time integrity check; checksums in `docs/toolchain.lock.md` | CI `npm ci` |
| STK-004 | `android/app/build.gradle`, `ios/scripts/configure_project.rb` | builds |
| DEV-001 | minSdk 29 / iOS 17; release ABI filters | builds |
| DEV-002, DEV-003 | `src/domain/model/eligibility.ts`, `DeviceCheck` in `SetupScreen.tsx`, `app/platform/DeviceProfile.kt`, `iOS/PlatformService.swift` | JS `domain/modelInstall`, `ui/journey` |
| DEV-004 | `LlamaRnEngine.load` (Metal-or-fail, Android rejects GPU) | device M1 **open** |
| DEV-005 | `android/scripts/check-16kb-alignment.sh` | T28 **open** (needs built APK) |
| DEV-006 | `src/design/components/Screen.tsx` (720 px column), safe areas | screenshots **open** |

## 4. Architecture

| ID | Implementation | Verification |
|---|---|---|
| ARC-001 | directory boundaries | `tests/arch/check-boundaries.js` |
| ARC-002 | `src/app/services.ts`, `ChatSessionController` | JS `domain/chatSessionController` |
| ARC-003 | native transfer services; `ModelInstallController` mirrors only; `transferTypes.parseSnapshot` | JS `domain/modelInstall`; JVM `TransferServiceTest`; XCT `TransferServiceIntegrationTests` |
| ARC-004 | SQLite authoritative; stores hold mirrors only (`src/app/stores.ts`) | review; `check:arch` |

## 5–7. Model, distribution, descriptor

| ID | Implementation | Verification |
|---|---|---|
| MDL-001…005 | `model-release/acquire.py`, `requirements.lock.txt`, `.gitignore` | run **open** (rights gate) |
| MDL-006 | `model-release/desktop-smoke/` | node `smoke.test.mjs` (stubbed); real run **open** |
| DST-001…005 | `infra/modules/model-distribution`, `infra/envs/*` | static checks only; `terraform validate/apply` **open** |
| DST-002, DST-003 | `model-release/publish/*.mjs`, `docs/runbooks/model-publication.md` | node `publish.test.mjs` against the fault server |
| SIG-001…003 | `model-release/descriptor/{sign,verify,strict-json}.mjs`; `core/descriptor/*`, `core/json/StrictJson.kt`; `iOS/DescriptorVerifier.swift`, `iOS/StrictJSON.swift` | 41 shared vectors: node, JVM `DescriptorVectorsTest`, XCT `DescriptorVerifierTests` (T08, T29) |
| SIG-004 | bundled descriptor exempt from expiry; keys only in the app bundle | vectors `expired-bundled-still-trusted`; T30 procedure in `signing-keys.md` |
| SIG-005 | `OfflineStorageScreen.tsx` (check only on tap) | JS `ui/chatJourney` (no `checkForUpdate` call), vector `signed-rollback…` |

## 8. Transfer, installation, storage

| ID | Implementation | Verification |
|---|---|---|
| DL-001 | `src/infrastructure/platform/specs/NativeNamuTransfer.ts`; `core/transfer/TransferService.kt`; `iOS/TransferService.swift` | JVM `TransferServiceTest`, XCT |
| DL-002 | `core/transfer/SqlJournal.kt`, `app/transfer/AndroidSqlDriver.kt`; `iOS/TransferJournal.swift` | JVM `JournalContractTest`, XCT `TransferJournalTests` |
| DL-003, DL-004 | `core/transfer/TransferEngine.kt`, `ResponseRules.kt` | JVM `TransferEngineTest`, `ResponseRulesTest` (T03–T07) |
| DL-005 | `iOS/TransferService.swift`, `AppDelegate.swift` | XCT `TransferServiceIntegrationTests`; T12 device **open** |
| DL-006 | `core/transfer/NetworkPolicy.kt`, `app/transfer/AndroidNetworkPolicy.kt`; consent dialogs in `SetupScreen.tsx`/`OfflineStorageScreen.tsx` | JVM `SpaceAndNetworkRuleTest`; JS `ui/journey` (metered consent) |
| DL-007 | `core/transfer/RetryPolicy.kt`; iOS retry handling | JVM `RetryPolicyTest` |
| DL-008 | `core/store/StorageLayout.kt`; `iOS/ModelStore.swift` | JVM/XCT store tests |
| DL-009 | `core/transfer/SpaceRule.kt`; `eligibility.ts` | JVM `SpaceAndNetworkRuleTest`; JS `domain/modelInstall` (T09 partial) |
| DL-010…012 | `core/store/{ModelStore,ActivePointerStore,DurableFiles}.kt`, `core/gguf/GgufCheck.kt`, `core/hash/Sha256Streamer.kt`; iOS equivalents; `ModelInstallController.ts` | JVM `ActivationCrashTest` (T10), `GgufCheckTest`; XCT `ActivePointerTests`, `ModelStoreTests`; JS `domain/modelInstall` (T11) |
| DL-013, DL-014 | `ModelStore` retention + startup reconciliation | JVM/XCT store tests |
| DL-015 | `transferTypes.ts` (TransferPhase) vs `InferenceEngine.ts` (EngineState) | JS `domain/modelInstall` |

## 9–10. Inference, prompt, context

| ID | Implementation | Verification |
|---|---|---|
| INF-001 | `LlamaRnEngine.ts`, `docs/engineering/runtime-contract.md` | device M1 **open** |
| INF-002 | `LlamaRnEngine.format` (embedded template, exact count incl. BOS) | reference-render fixtures **open** (needs artifact) |
| INF-003 | `model-release/inspect-header.mjs` → `runtimeFixture.ts`, `controlTokens.ts` | JS `infrastructure/controlTokens` |
| INF-004 | `resetSession()` before every generation | JS T17 |
| INF-005 | sequence numbers in the adapter; controller drops obsolete/out-of-order chunks | JS `domain/chatSessionController` |
| INF-006 | `EngineOwnership.ts`; `requestStop` + 5 s timeout | JS T14, T15, CANCEL_TIMEOUT |
| INF-007 | lazy load, 120 s idle unload, background stop (`App.tsx`, controller) | JS lifecycle tests |
| INF-008 | `onThermalState` + 30 s recovery; native listeners | JS lifecycle tests; device **open** |
| CTX-001 | `src/domain/chat/systemPrompt.ts` | JS `domain/text` |
| CTX-002, CTX-003 | `promptBudget.ts`, `ChatRepository.getContextPairs` | JS T19, `domain/text`, T18 |
| CTX-004 | `contextTrimmed` → quiet notice in `ChatScreen.tsx` | JS trimming test |
| CTX-005 | `finish_reason = 'length'` + label | JS controller + UI label |
| CTX-006 | per-conversation `response_language`; no detection downloads | JS |

## 11–12. Conversations and SQLite

| ID | Implementation | Verification |
|---|---|---|
| CHAT-001 | `ChatRepository.send`; composer clears only on accepted | JS `data/chatRepository`, `ui/chatJourney` |
| CHAT-002 | controller publish 50 ms / checkpoint 1 s or 1 KiB; `ActiveAnswer.tsx` | JS T16 |
| CHAT-003 | guarded UPDATEs; `recoverInterruptedAttempts` | JS `data/chatRepository` |
| CHAT-004, CHAT-005 | `createRetryAttempt`, `finishInTransaction`, `selectAttempt` | JS T18 |
| CHAT-006 | `BUSY` outcome, `ReturnToAnswerBanner.tsx` | JS T14 |
| CHAT-007 | `title.ts`, drafts `new-chat` key | JS `domain/text`, `data/chatRepository` |
| DB-001 | `Database.ts`, `OpSqliteDriver.ts` | JS `data/migrations` |
| DB-002 | triggers in `migrations/001_initial.ts` | JS integrity tests |
| DB-003 | `PreferencesRepository.ts`, `Composer.tsx` (300 ms) | JS `data/diagnostics` (defaults) |
| DB-004, DB-005 | keyset pages, `search_rows` + FTS5, `ftsQuery.ts` | JS `data/search`, `data/scale` |
| DB-006 | `openChatDatabase.ts`, `migrations/runner.ts` | JS `data/migrations` (T21) |

## 13–15. Screens, design, localization, accessibility

| ID | Implementation | Verification |
|---|---|---|
| S01 | `features/setup/OnboardingScreen.tsx` | JS `ui/journey` |
| S02, S03 | `features/setup/SetupScreen.tsx` | JS `ui/journey` (T01) |
| S04 | `features/chat/*`, `design/components/ChatMessage.tsx`, `design/markdown/*` | JS `ui/chatJourney`, `design/parseMarkdown` (T20) |
| S05 | `features/conversations/ConversationsPanel.tsx` (drawer content, PA-007) | JS `ui/chatJourney` |
| S06–S09 | `features/settings/*` | JS `ui/chatJourney` |
| S10 | `features/about/*`, vendored notices | JS; legal review **open** |
| UX-001 | `app/Navigation.tsx`, `lastConversationId` | JS |
| DS-001…003 | `design/tokens.ts`, fonts, icon subset | asset inventory |
| DS-004 | `design/check-contrast.js`, reduced motion in `Navigation.tsx`, haptics only on actions/terminal | `npm run check:contrast` |
| DS-005 | `design/components/*` | JS UI tests |
| LOC-001 | `locales/*`, `format.ts` | `check:locales` (T25) |
| LOC-002 | `review-status.json` release gate | human review **open** |
| A11Y-001 | single announcements (`services.ts`), 10 % progress milestones (`DownloadProgress.tsx`) | JS announcement assertions; T24 device **open** |
| A11Y-002 | `Composer.tsx` (Return = newline, hardware shortcut), `direction.ts` | JS shortcut test |

## 16–18. Privacy, errors, NFR, observability

| ID | Implementation | Verification |
|---|---|---|
| SEC-001 | Android backup rule XMLs, `noBackupFilesDir`; iOS backup exclusion + file protection | T27 device **open** |
| SEC-002 | no custom encryption; diagnostics allow-list | JS `data/diagnostics` |
| SEC-003 | no JS network; Markdown images disabled | `check:arch`, JS T20, T26 device **open** |
| SEC-004, SEC-005 | `core/export/Exporter.kt`, `app/export/*`, `iOS/ExportService.swift`, `useExport.tsx` | JVM `ExporterTest`, XCT `ExportServiceTests`, JS export flow (T23 partial) |
| SEC-006 | `PrivacyScreen.tsx`, `services.deleteAllData`, `quiesce()` | JS `ui/chatJourney` (T22) |
| SEC-007 | WAL truncate after deletion; `FLAG_SECURE`; `iOS/PrivacyCover.swift` | T27 device **open** |
| Section 17 codes | `domain/inference/failures.ts`, `errors.*` strings | JS |
| ERR-001 | `nativeLoadMarker`, safe mode | JS safe-mode test; T13 device **open** |
| NFR-001…012 | `benchmarks/harness`, `benchmarks/historyFixture.ts` | NFR-010 JS guard; all device gates **open** |
| OBS-001 | `data/diagnostics/DiagnosticsStore.ts` | JS `data/diagnostics` |
| OBS-002 | diagnostic spans in controller/adapter | Perfetto/Instruments **open** |
| OBS-003, OBS-004 | `benchmarks/harness/runner.ts`, `benchmarks/devices.json` | — |

## 19–22. Qualification, evaluation, release

| ID | Implementation | Verification |
|---|---|---|
| QA-001…003 | `benchmarks/devices.json`, harness workloads | device **open** |
| QA-004 | fake engine/transfer adapters (`tests/support`), separate native suites | JS |
| EVAL-001…004 | `benchmarks/eval/` | validator; human scoring **open** |
| REL-001, REL-002 | `.github/workflows/ci.yml`, `tools/release/*` | workflows not yet executed |
| REL-003 | `tools/release/build-record.mjs` | — |
| REL-004…007 | `docs/runbooks/*` | owner actions **open** |
