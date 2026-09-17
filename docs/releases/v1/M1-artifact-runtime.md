# M1 — Artifact and runtime  ·  GATE OPEN (partly run)

IMP-001: a correctness or performance failure here must be investigated before
the rest of the product is trusted. **The artifact is locked and the real model
has run inside the iOS app on a simulator (2026-09-17). No physical device has
run it, so the gate stays open.**

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

**Real-model run — iOS simulator, 2026-09-17** (iPhone 17 Pro simulator, iOS
26.4, Intel i7-1068NG7 host, CPU backend, 4 threads; internal Debug build)

* `acquire.py` run; `model-release/model.lock.json` committed: 2,143,977,056
  bytes, SHA-256 `d01d9952…4570a`, revision `a602ea7e…`, `cohere2`, Q4_K_M
  (MDL-003). `inspect-header.mjs --file` on the downloaded file reproduces
  `runtime-fixture.json` byte for byte (apart from the revision label).
* Full install path with the real file: signed dev descriptor (locked
  production profile) → 2.14 GB download from the local fault server → hash →
  GGUF check → **real self-test passed** (517 prompt tokens, 21 output tokens)
  → activation.
* Chat with the real model, all through the product UI:

  | Case | Prompt tokens (counted = evaluated) | Output | Result |
  |---|---|---|---|
  | English, first turn ("Hi") | 535 = 535 | 9 tokens | `complete/eos` |
  | Hausa, 2nd turn (maize planting) | 572 = 572 | 202 tokens, Markdown list | `complete/eos`, fluent Hausa |
  | French, 3rd turn (2 earlier pairs in context) | 806 = 806 | 79 tokens | `complete/eos` |
  | Stop during prefill | 569 = 569 | 0 | `stopped/cancelled`, no CANCEL_TIMEOUT |
  | Stop during decode | 905 = 905 | 36 tokens kept | `stopped/cancelled`, partial retained |

  No control token or stop marker reached the screen or the database in any
  answer. `prompt.count.mismatch` was never recorded, which confirms the
  "tokenize + 1 BOS" counting rule of runtime-contract §2 against the runtime.
* Speed on this host (not a product measurement): load 4–6 s, prefill ≈ 20–23
  tokens/s, decode ≈ 8–9 tokens/s. The mandatory template preamble makes every
  first token wait for ≥ 535 prompt tokens (PA-001).
* Screenshot: `screenshots/real-model-hausa-ios-sim.png`.

Findings from that run (all fixed in the same change unless noted):

1. llama.rn's simulator framework is compiled with `LM_GGML_CPU_GENERIC` (no
   SIMD). On an Intel Mac the model was unusable (self-test 7 min, no first
   token in 10 min). `ios/scripts/build_llama_sim_x86.sh` rebuilds the same
   pinned sources with AVX2 for Debug simulator builds only
   (docs/engineering/ios-native-notes.md).
2. On the simulator llama.rn zeroes the GPU layers but leaves the emulated
   Metal device selected, so prompt batches were offloaded to it. Internal
   simulator builds now name the CPU devices explicitly.
3. The iOS native module reports `osName: "iOS"`; the adapter compared it with
   `'ios'` and classified iPhones as Android (eligibility thresholds and
   diagnostics). Fixed; case-insensitive.
4. llama.rn's `timings.prompt_ms` reported 67 s of prefill for a generation
   that lasted 56 s in total, right after a cancelled request (observed once;
   cause not traced in llama.rn). Diagnostics now use the adapter's own wall
   clock.
5. English autocorrect rewrote Hausa even with an English UI ("Sannu" →
   "Danny"); the composer no longer autocorrects or spell-checks.
6. The first message of a new chat came back as the new-chat draft; fixed with a
   regression test.
7. Model behaviour, not fixed here: after a French turn, an English request was
   answered in French although the system prompt says to match the latest
   message. Belongs to the LANG evaluation (M7).
8. Asked who it is, the model answered "I'm Aya, a language model built by
   Cohere" (8 of 8 samples) because the template's default preamble says so.
   Fixed by the owner-approved `namu-text-2` instruction (PA-006): "Namu" in 33
   of 35 samples and "Aya" in none, measured with
   `model-release/desktop-smoke/identity-probe.mjs` on llama.cpp b10256.

**Not done — required evidence for this milestone**
* No physical Android phone or iPhone has run the app; every number above is
  from a simulator on a laptop CPU. Metal (`n_gpu_layers = 99`) has never been
  initialised by this app.
* llama.cpp b10256 is now built locally (`model-release/desktop-smoke/.build/`,
  git-ignored; commit `6c8dcaa7ae41fa9f4aa2b3b68ee82cb8b2a03632`) and was used
  for the identity probe, but the full MDL-006 smoke run and the
  `getFormattedChat` reference comparison have not been run.
* Cancel acknowledgement P95, `clearCache(true)` cost and NFR timings need the
  device matrix.
