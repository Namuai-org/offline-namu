# PRD section 20 — mandatory failure and security tests

Legend — **auto**: an automated test exercises the behaviour off-device
(Jest with fakes, JVM tests against an in-process fault server, XCTest on the
simulator). **device**: the PRD pass condition needs a physical device or real
infrastructure and has **not** been run. A row is only "passed" for release
purposes when its device column is done.

| ID | Test | Automated coverage | Device / real-world run |
|---|---|---|---|
| T01 | Clean install, no network | auto — JS `ui/journey` | open |
| T02 | Installed, airplane mode, cold launch | auto — JS `ui/chatJourney` (no transfer/update calls during the journey); Maestro `05-airplane-mode.yaml` written | open |
| T03 | Drop connection at 10 / 50 / 99 % | auto — JVM `TransferEngineTest`; XCT integration against a local server | open (incl. iOS explicit restart) |
| T04 | 200 to Range | auto — JVM `TransferEngineTest`, `ResponseRulesTest` | open |
| T05 | Wrong Content-Range / changed ETag / truncated body | auto — JVM | open |
| T06 | 416 complete vs incomplete | auto — JVM | open |
| T07 | Endless / oversized body | auto — JVM; XCT | open |
| T08 | Invalid signature / hash / schema / sequence | auto — 41 shared vectors in node, JVM and XCT; GGUF check only after hash | open |
| T09 | Fill storage during transfer / hash / activation | auto (space-probe injection) — JVM | open (real full disk) |
| T10 | Kill at each activation checkpoint | auto — JVM `ActivationCrashTest`, XCT `ActivePointerTests` (crash-injection hooks) | open (real process kill) |
| T11 | Update while answering | auto — JS `domain/modelInstall` | open |
| T12 | iOS force-quit during background download | none (cannot be automated) | open |
| T13 | Native load crash / invalid allocation | auto (marker → safe mode) — JS | open |
| T14 | Rapid Send twice / Stop twice / change screens | auto — JS controller + UI | open |
| T15 | Cancel during prefill / decode | auto with the scripted engine — JS | open (real native acknowledgement) |
| T16 | Kill while streaming | auto — JS | open |
| T17 | Sentinel across conversations | auto — JS (prompt + reset order) | open (real KV cache) |
| T18 | Retry then next turn | auto — JS | open |
| T19 | Huge paste / budget overflow | auto — JS controller + UI | open |
| T20 | HTML, images, javascript links, deep nesting | auto — JS `design/parseMarkdown` | open (proxy check for zero requests) |
| T21 | Migrate each prior DB version; inject failure | auto — JS `data/migrations` (only schema v1 exists) | open |
| T22 | Delete chat / all data / model during activity | auto — JS UI + controller `quiesce` | open |
| T23 | Export cancelled / low space / share failure | partial — JS failure path, JVM/XCT exporter | open |
| T24 | TalkBack / VoiceOver + 200 % text | none | open |
| T25 | Locale key / plural / placeholder checks | auto — `npm run check:locales` | n/a |
| T26 | Proxy / network inspection | static — `check:arch` forbids JS network I/O | open |
| T27 | OS backup / restore and app-switcher capture | none | open |
| T28 | Native library / 16 KB packaging | script only | open (needs a built APK/AAB) |
| T29 | Same sequence altered payload; expired metadata | auto — shared vectors | open |
| T30 | Key rotation via app upgrade | procedure in `docs/runbooks/signing-keys.md` | open |
