# Runtime contract report — llama.rn 0.12.9 / llama.cpp b10256 (M1)

Status: **desk-verified against the pinned package source and the locked GGUF
metadata; NOT yet verified on a physical device.** IMP-001 applies: the M1 gate
(no-network generation on a physical Android phone and an iPhone) is still
open and blocks everything that depends on measured behaviour.

Sources read: `node_modules/llama.rn/src/{index,types,version}.ts`,
`node_modules/llama.rn/cpp/{rn-llama.cpp,rn-completion.cpp,llama-vocab.cpp,common/chat.cpp}`
and the GGUF header of `CohereLabs/tiny-aya-global-GGUF@a602ea7eeec3a4ad6f77a1b8cf6a53512824922b`
(`model-release/runtime-fixture.json`, produced by `model-release/inspect-header.mjs`
through HTTP range requests — 11.9 MB of metadata, no tensor data).

## 1. Configuration mapping (INF-001)

| PRD setting | Value | Pinned API field | Notes |
|---|---|---|---|
| Context | 2,048 | `initLlama({n_ctx})` | |
| Max generated tokens | 384 | `completion({n_predict})` | |
| Prompt ceiling | 1,632 | enforced by `domain/chat/promptBudget.ts` | runtime never truncates: `ctx_shift: false` |
| Temperature / top_p / top_k | 0.3 / 0.9 / 40 | `temperature`, `top_p`, `top_k` | |
| Repeat penalty | 1.1 | `penalty_repeat` | `penalty_last_n` left at the runtime default (64) |
| Production seed | runtime random | `seed: -1` | the binding does not report the chosen seed, so none is recorded |
| Test seed | 42, greedy | `seed: 42, temperature: 0, top_k: 1, top_p: 1, penalty_repeat: 1` | used by the DL-011 self-test |
| CPU threads | min(4, logical CPUs) | `n_threads` (context and completion) | CPU count from the native platform module |
| Batch / micro-batch | 256 / 128 | `n_batch`, `n_ubatch` | |
| KV cache | F16 K and V | `cache_type_k: 'f16'`, `cache_type_v: 'f16'` | |
| mmap / mlock | on / off | `use_mmap: true`, `use_mlock: false` | |
| GPU layers | Android 0, iOS 99 | `n_gpu_layers` | iOS: `context.gpu` must be true or the context is released and an unsupported-runtime failure is raised (DEV-004). Android: a GPU context is rejected |
| Parallel requests | 1 | `n_parallel: 1` | the parallel/queue API is never used |
| Context shifting | disabled | `ctx_shift: false` | |
| Speculation, embeddings, multimodal, tools | disabled | `speculative: false`, `embedding: false`; `initMultimodal`, tools and `response_format` are never called | |
| Session reset | per generation | `context.clearCache(true)` | clears KV metadata and tensor data, keeps weights (INF-004) |
| Stop | out-of-band | `context.stopCompletion()` | `cancel()` resolves only after the running `completion()` promise has settled — that is the acknowledgement (INF-006) |

**Accepted-value assertion.** The binding does not echo the effective context
parameters back to JS. What the runtime *does* report is recorded in the
`engine.config` diagnostic event: requested values plus `gpu` and the backend
mode. Verifying the effective `n_ctx`/`n_batch` requires native logs
(`toggleNativeLog`) on a device; this is an open M1 item, not a silent
omission.

No patch to the pinned native source was necessary so far: there is no patch
hash to record.

## 2. Template and token counting (INF-002)

* The GGUF embeds a Jinja template (SHA-256
  `2147c474f41b522b7296f74692b9f31e45f49a31465960576a9d321339c5915a`). It is
  always applied through the runtime (`getFormattedChat(..., {jinja: true,
  add_generation_prompt: true})`); roles are never hand-concatenated. If the
  runtime falls back to a non-Jinja formatter the adapter fails with
  `MODEL_INCOMPATIBLE`.
* The template **always renders Cohere's upstream preamble** ("System
  Preamble" + "Default Preamble", which names the assistant *Aya*), and puts
  Namu's `namu-text-1` instruction under `# Developer Preamble`, which the
  template states takes precedence. The combined prompt is what gets counted
  and budgeted; nothing is duplicated manually (CTX-001).
* **Counting subtlety.** `context.tokenize()` calls
  `common_tokenize(add_special=false)` while the completion path uses
  `add_bos = llama_vocab_get_add_bos()`. The vocabulary has
  `add_bos_token = true`, and `common/chat.cpp` strips the template's leading
  `<BOS_TOKEN>` text for that reason. Therefore
  `formatted tokens = tokenize(prompt).length + 1`. The adapter applies this
  and, on every generation, compares it with the runtime's
  `tokens_evaluated`; any difference is recorded as `prompt.count.mismatch`.
  The 32-token safety margin absorbs a ±1 error until device verification.
* The count is taken on exactly the string later submitted: the formatted
  result is cached by message content and reused by `generate`.

### PRD inconsistency to resolve (tracked)

DL-011 and NFR-002 speak of a "128-token formatted prompt". The upstream
preamble alone is about 1,900 characters (several hundred tokens), so **no formatted prompt can be 128
tokens with this template**. The self-test uses a fixed fixture message and
records the measured formatted count; NFR-002 should be re-stated as "fixture
content of N tokens" or "formatted prompt of N tokens" in a PRD amendment
once the real count is measured on device.

## 3. End of generation and stop markers (INF-003)

* Metadata: BOS `<BOS_TOKEN>` (2), EOS `<EOS_TOKEN>` (3), no EOT id.
* `llama-vocab.cpp` (b10256) auto-detects end-of-generation tokens from a fixed
  name list that does **not** contain `<|END_OF_TURN_TOKEN|>` or
  `<|END_RESPONSE|>`. With this runtime only `<EOS_TOKEN>` ends generation
  natively.
* The template closes an assistant turn with
  `<|END_RESPONSE|><|END_OF_TURN_TOKEN|>`. These two markers are **derived from
  the locked template** by `inspect-header.mjs` (and asserted to be CONTROL
  tokens of the locked vocabulary) and passed as `stop`. No generic
  Llama/Qwen/Gemma stop list is used.
* Visible-output guard: all 23 CONTROL tokens of the locked vocabulary are in
  the generated `runtimeFixture.ts`. The adapter (a) holds back any trailing
  fragment that could still become a control token while streaming, (b) cuts
  the answer at the first control token if one ever appears, and (c) neutralizes
  control-token text inside *user* content in the prompt copy only, because the
  runtime tokenizes prompts with special-token parsing enabled.

## 4. M1 verification items

Status after the first real-model run (iOS simulator, CPU backend, 2026-09-17;
details in `docs/releases/v1/M1-artifact-runtime.md`):

1. **Done.** `acquire.py` run and `model.lock.json` committed; the local file
   reproduces the header-derived fixture exactly.
2. Open. Reference render of the template (desktop `llama.cpp` b10256) vs the
   mobile `getFormattedChat` output for the fixtures.
3. **Confirmed on iOS simulator** (`tokens_evaluated == counted` for 517, 535,
   569, 572, 806 and 905-token prompts). Open on Android and on devices.
4. **Confirmed on iOS simulator** for English, Hausa and French, first turn and
   multi-turn: answers end on a stop marker/EOS with nothing leaked. Open on
   Android and on devices.
5. Cancel during prefill and decode works and never hit the 5 s timeout, even
   on a laptop CPU. The P95 ≤ 1 s measurement needs devices.
6. Open. iOS Metal with `n_gpu_layers = 99`; Android stays on CPU.
7. Open. `clearCache(true)` cost on target devices.

### Simulator-only behaviour (DEV-001)

* llama.rn disables Metal on the simulator by setting `n_gpu_layers = 0`, but it
  does not remove the (emulated) Metal device from the context, so llama.cpp
  still offloads prompt batches to it. The adapter passes
  `devices: [<cpu devices>]` for internal simulator builds only; real devices
  never receive a `devices` override.
* `result.timings.prompt_ms` exceeded the whole generation's wall time once,
  directly after a cancelled completion (cause not traced). The adapter reports
  wall-clock prefill/decode instead.
