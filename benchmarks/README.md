# Benchmarks and qualification (M7)

| Path | Purpose |
|---|---|
| `devices.json` | QA-001 inventory: exact models, SoCs and OS versions; qualified and excluded lists (OBS-004) |
| `harness/` | End-to-end workload runner over the product's own `NamuEngine` adapter (QA-002, NFR-002…005, NFR-008, NFR-009) |
| `historyFixture.ts` | 1,000 conversations / 10,000 messages fixture (NFR-001, NFR-010) |
| `eval/` | 330-prompt language evaluation set and scoring tools (section 21) |

Rules that the harness encodes:

* A report is `device-release` evidence only when it ran in a **release build on
  a physical device**; anything else is stamped `not-evidence` (OBS-003).
* Every report carries the full identity required by OBS-003: device model and
  OS, available memory, runtime build ID, artifact digest, app build,
  thread/context/batch parameters, charging state, thermal state, sample
  counts and the fixture hash.
* One declared warm-up, then **every** sample is kept — no cherry-picking
  (NFR-004). First-token gate uses 30 samples per language (QA-002).
* A device that fails a gate goes to `excluded` in `devices.json` with its
  report; targets are never lowered silently (OBS-004).

What this harness cannot measure and must be captured with platform tools
(OBS-002): frame times and freezes (NFR-006, Perfetto / Instruments), settled
native memory across cycles (NFR-008), battery drain (QA-003), thermal readings
on devices without a thermal API, and llama-bench kernel metrics.

**Status: no device has been measured.** `devices.json` lists the required test
roles with no hardware recorded, and `qualified` is empty.
