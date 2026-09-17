# Namu Offline v1 — release evidence (IMP-002)

One file per milestone of PRD section 23. A milestone is **not** complete from
code presence alone: each file separates what was *built*, what was *verified
and how*, and what is still *open*. Nothing here claims device results that
were not measured.

| Milestone | State | Evidence |
|---|---|---|
| M0 — Foundation and rights | **partial** — stack initialized, dependencies pinned, assets imported; rights record, app-ID registration, Android build and Gradle verification metadata open | [M0-foundation.md](M0-foundation.md) |
| M1 — Artifact and runtime | **open gate** — adapter, fixture and tools built; artifact not acquired; no physical-device run | [M1-artifact-runtime.md](M1-artifact-runtime.md) |
| M2 — Durable data | **built and tested off-device** | [M2-data.md](M2-data.md) |
| M3 — Model delivery | **built; protocol tested on JVM / simulator against a fault server**; infrastructure not provisioned | [M3-delivery.md](M3-delivery.md) |
| M4 — Chat behaviour | **built and tested with the fake engine**; T14–T19 on real devices open | [M4-chat.md](M4-chat.md) |
| M5 — Complete product UI | **built**; translations are unreviewed drafts; screenshots and screen-reader passes open | [M5-ui.md](M5-ui.md) |
| M6 — Hardening | **partial** — Markdown, deletion/export flows, boundary checks done; backup/OEM, proxy audit, 16 KB packaging open | [M6-hardening.md](M6-hardening.md) |
| M7 — Qualification | **not started** — harness and evaluation set exist; no device measured, no human scoring | [M7-qualification.md](M7-qualification.md) |
| M8 — Release | **not started** | [M8-release.md](M8-release.md) |

Also here: [traceability.md](traceability.md) (requirement → code → test),
`sbom/` (CycloneDX), and the PRD section 20 status table in
[test-matrix.md](test-matrix.md).

IMP-001 note: the PRD requires M1 to be proven on hardware before the rest of
the product is built. The rest was built anyway because hardware and the
artifact were not available to the implementer; **treat everything downstream
of M1 as provisional until the M1 gate passes**, and expect the inference
adapter to be the first thing that needs adjustment.
