# M2 — Durable data

**Built:** `src/data/` — driver contract, `Database` (WAL, `synchronous=FULL`,
foreign keys, 5 s busy timeout, one serialized async write queue), migration 1
(PRD §12 schema + selection-integrity triggers + FTS5 index with a rowid map),
checksum-locked migration runner, backup/recovery orchestration
(`openChatDatabase.ts`), repositories (chat, conversations, drafts,
preferences, search), diagnostics ring, fake engine.

**Verified (Jest against real SQLite 3.52 via `node:sqlite`, development Mac):**

| Suite | What it proves |
|---|---|
| `tests/data/chatRepository.test.ts` | CHAT-001 atomic send and rollback leaving the draft; guarded terminal transitions (late completion cannot overwrite a stop); restart recovery → `interrupted`; retry/selection rules; T18 source rows; DB-002 triggers; cascade delete; SEC-006 scope; keyset pagination with timestamp ties |
| `tests/data/search.test.ts` | literal FTS compilation (hostile input), case-insensitive Hausa hooked letters, apostrophes/accents, title index follows rename, streamed text is not indexed, 50/page |
| `tests/data/migrations.test.ts` | checksum lock, WAL/FULL/FK pragmas, backup → migrate → cleanup after one clean restart, **T21** failed migration → prior DB preserved + read-only recovery, newer-schema refusal |
| `tests/data/scale.test.ts` | 1,000 conversations / 10,000 messages: search and paginated open P95 ≤ 500 ms **on the development Mac** |
| `tests/data/diagnostics.test.ts` | allow-listed diagnostic fields only; 7-day pruning |

**Open:**
* NFR-001 / NFR-010 on the device matrix (the Mac numbers are a regression
  guard, not evidence — OBS-003).
* op-sqlite driver (`src/infrastructure/db/OpSqliteDriver.ts`) is type-checked
  but has only run inside the app on a simulator/device, never under Jest.
* NFR-011 repeated process-kill injection on device.
