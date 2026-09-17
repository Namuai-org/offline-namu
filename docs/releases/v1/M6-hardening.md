# M6 — Hardening

| Area | State |
|---|---|
| Safe Markdown (T20) | done — bounded parser, HTML inert, images → alt text, http/https links only with hostname confirmation, 12-level / 64 KiB limits (`tests/design/parseMarkdown.test.ts`) |
| No JS network I/O (SEC-003, NFR-012) | enforced statically by `npm run check:arch`; on the simulator the fault-server log shows exactly one request (the artifact GET) for the whole setup + chat journey |
| Diagnostics privacy (OBS-001) | done — allow-listed fields only, 5 MiB / 7 days |
| Deletion scopes (SEC-006, T22) | done in JS with shutdown confirmation; deferral when the engine cannot be confirmed stopped |
| Export (SEC-004/005, T23) | native streaming exporters tested on JVM and XCTest; Android leaves the file for the 24 h sweep because the chooser gives no completion signal |
| DB migration safety (T21) | done — after an independent review found that a failed restore could remove the user's database, the restore path was removed entirely: nothing is ever replaced or deleted; recovery reads the consistent backup |
| Backup exclusions (SEC-001, T27) | configured on both platforms (Android: both rule generations + `allowBackup=false`; iOS: backup exclusion + file protection); **not verified on devices/OEMs** |
| App-switcher privacy (SEC-007) | implemented (FLAG_SECURE / iOS cover view); not visually verified |
| 16 KB pages (DEV-005, T28) | script exists and was exercised on synthetic packages; **needs a real APK/AAB** |
| Proxy audit (T26) | open |
| Independent code review | done once; 16 findings, all fixed with regression tests (see commit `487757f`) |
