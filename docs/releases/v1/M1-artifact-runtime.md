# M1 — Artifact and runtime  ·  GATE OPEN

IMP-001: a correctness or performance failure here must be investigated before
the rest of the product is trusted. **This gate has not been run.**

**Built**
* `model-release/acquire.py` (verbatim from PRD §5) and
  `requirements.lock.txt` (`huggingface_hub==1.32.0`).
* `model-release/inspect-header.mjs` → `runtime-fixture.json` and the generated
  `src/infrastructure/inference/runtimeFixture.ts`: template hash, BOS/EOS,
  all 23 CONTROL tokens and the derived stop markers, read from the GGUF
  metadata of upstream revision `a602ea7eeec3a4ad6f77a1b8cf6a53512824922b`
  through range requests (metadata only; no weights downloaded).
* `LlamaRnEngine` adapter with the fixed configuration, exact formatted-token
  counting, session reset, latched out-of-band cancel, Metal-only policy on
  iOS, deterministic self-test. Findings in
  `docs/engineering/runtime-contract.md`.
* `model-release/desktop-smoke/` (MDL-006) — script only.

**Verified**
* Adapter contract against a scripted llama.rn: `tests/infrastructure/llamaRnEngine.test.ts`
  (configuration mapping, BOS count, stop strings, control-token cut, cancel
  latch and acknowledgement, no unload while generating, DEV-004).
* The pinned native library links and initialises inside the iOS app (simulator).

**Not done — required evidence for this milestone**
* `acquire.py` has **not** been run; there is **no `model.lock.json`**. The
  upstream API currently reports 2,143,977,056 bytes and SHA-256
  `d01d9952…4570a` — unverified metadata, not a lock (MDL-003).
* No generation with the real model anywhere: not on desktop, not on a
  simulator, not on a phone. No template reference render, no
  `tokens_evaluated` parity check, no stop/cancel timing.
* No physical Android phone or iPhone has run the app.
