# Desktop smoke test (MDL-006)

Runs the locked Tiny Aya Global Q4_K_M artifact on a desktop with the **same
runtime family as the app**: llama.cpp at tag **`b10256`**, the revision
bundled by llama.rn 0.12.9 (STK-002). It verifies Hausa, French and English
answers, multi-turn formatting and stop behaviour, and it writes the
template/stop-token fixtures the mobile adapter tests compare against
(INF-002, INF-003). **Desktop success does not replace mobile testing.**

> **Execution status.** llama.cpp `b10256` has been built locally (commit
> `6c8dcaa7ae41fa9f4aa2b3b68ee82cb8b2a03632`, CPU only) and the locked 2.14 GB
> artifact is downloaded. `identity-probe.mjs` (below) **has** been run against
> them. `run-smoke.mjs` itself has still only been executed against **stub**
> `llama-server`/`llama-tokenize` programs (`smoke.test.mjs`, part of
> `node --test model-release/`); the real smoke run and the template reference
> render are outstanding. The Hausa prompt wording has not been reviewed by a
> native speaker.

## Prerequisites

* The artifact and lock from `model-release/acquire.py` (see `../README.md`),
  i.e. model-use authorization is already in place (PRD-007).
* git, CMake ≥ 3.14 and a C/C++ toolchain; Node ≥ 22.11. About 3 GB of free
  memory for the run.

## 1. Build llama.cpp at the pinned tag

Outside the repository (or in a git-ignored directory):

```bash
git clone --depth 1 --branch b10256 https://github.com/ggml-org/llama.cpp llama.cpp-b10256
cd llama.cpp-b10256
git rev-parse HEAD        # expected: 6c8dcaa7ae41fa9f4aa2b3b68ee82cb8b2a03632 (tag b10256)

cmake -B build -DCMAKE_BUILD_TYPE=Release \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_UI=OFF -DLLAMA_OPENSSL=OFF
cmake --build build --config Release -j --target llama-server llama-tokenize
ls build/bin/llama-server build/bin/llama-tokenize
```

`LLAMA_BUILD_UI=OFF` and `LLAMA_OPENSSL=OFF` keep the build free of the web UI
and of HTTPS/download support: the smoke test is local and offline. On Apple
Silicon the default build enables Metal; the script still runs on the CPU
unless `--gpu-layers 99` is passed (use both: `0` mirrors Android, `99` mirrors
iOS, DEV-004). Do not substitute another tag "because it is newer": the point
is parity with the bundled runtime. If the tag cannot be built on the machine,
record that and use another machine; do not move the tag.

## 2. Run

```bash
node model-release/desktop-smoke/run-smoke.mjs \
  --llama-bin /path/to/llama.cpp-b10256/build/bin \
  --out model-release/desktop-smoke/out          # git-ignored
# second pass mirroring iOS offload on a Metal machine:
node model-release/desktop-smoke/run-smoke.mjs --llama-bin … --gpu-layers 99 --out model-release/desktop-smoke/out-metal
```

The script:

1. **Preflight**: size and SHA-256 of the artifact equal `model.lock.json`.
   Only a verified file is ever parsed (same order as DL-010).
2. **Artifact fixture** (`artifact-fixture.json`, via `gguf-metadata.mjs`, no
   llama.cpp involved): `general.*` and `cohere2.*` metadata, tokenizer model,
   special token ids **with their texts** (BOS/EOS/EOT/PAD…), every CONTROL
   token, `forbidden_output_markers` (the strings that must never reach the
   user), and the embedded chat template with its SHA-256. Stop markers are
   derived from this file, never from a generic Llama/Qwen list (INF-003).
   If `model-release/runtime-fixture.json` exists (the fixture the app compiles
   in, written by `inspect-header.mjs` from the upstream header), its revision,
   template hash, control tokens and stop markers must agree with the locked
   artifact; a difference is a failure (`--committed-fixture none` skips it).
3. **`llama-tokenize`**: each control token used by the chat template (the
   role/turn markers) must tokenize to exactly its own single id:
   `llama-tokenize -m <gguf> -p '<marker>' --ids --no-bos --log-disable`.
4. Starts **`llama-server`** on `127.0.0.1` with the PRD section 9
   configuration: `-c 2048 -n 384 -b 256 -ub 128 -t 4 -np 1 -ctk f16 -ctv f16
   --no-context-shift --jinja --offline --no-webui`, sampling `--temp 0.3
   --top-p 0.9 --top-k 40 --repeat-penalty 1.1 --seed 42` (test seed), and
   `cache_prompt: false` per request (INF-004: no cross-request KV reuse).
   `build_info` from `/props` must contain `10256`, and the server's
   `chat_template` must equal the GGUF's.
5. **Template fixtures** (`template-fixtures.json`): for first turn, system
   message, multi-turn and multilingual inputs, the rendered prompt from
   `POST /apply-template` and its token ids/count from `POST /tokenize`. These
   are the reference renders for the adapter's template and token-count tests
   (INF-002). The system text is the bundled `namu-text-2`
   (`smoke.test.mjs` fails if `prompts.json` drifts from
   `src/domain/chat/systemPrompt.ts`).
6. **Three languages, single turn** (`prompts.json`): explanation and
   translation in Hausa, explanation and summary in French, explanation and a
   "current news" limit case in English.
7. **Multi-turn**: a fact is given in turn 1 and asked back in turn 2, in
   English, French and Hausa; the final answer must contain it. This fails if
   role formatting is broken or history is dropped.
8. **Stop behaviour**: a natural end must report `finish_reason: "stop"`; a
   16-token cap must report `"length"` (the app's `length` label, CTX-005); a
   streamed answer is **cancelled by closing the connection** after 8 chunks
   and the next request must still be answered. This covers the runtime
   family; the app's own out-of-band cancel and 5-second acknowledgement rule
   (INF-006, T15) are mobile tests.

Every answer is checked mechanically: non-empty, no U+FFFD, **no control token
text in the visible output**, expected finish reason, expected recall word.
Exit status: `0` all mechanical checks passed, `1` at least one failed, `2`
the run could not be performed.

## 3. Read the outputs

`out/outputs.md` contains every prompt and answer. A person must read them:

* Hausa and French answers are judged by fluent readers (language correctness,
  requested-language adherence). Do not use Aya to grade itself (LOC-002); this
  smoke test is not the EVAL-001 evaluation.
* `en-limits` should say it cannot browse or access current news (CTX-001).
* Note anything odd about the template's own preamble: the combined prompt in
  `template-fixtures.json` (`system-message`) is what the model really sees
  (CTX-001: "verify the final combined prompt").

## 4. Keep the evidence

Copy `smoke-report.json`, `artifact-fixture.json`, `template-fixtures.json` and
`outputs.md` to `docs/releases/v1/` with the M1 evidence. They record the
artifact digest, prompt version and runtime build, as EVAL-004 requires. The
timings that llama-server prints are **not** performance results (OBS-003: no
claims from desktop or simulator runs).

## Files

| File | Purpose |
|---|---|
| `run-smoke.mjs` | the smoke test driver described above |
| `gguf-metadata.mjs` | dependency-free GGUF metadata and tokenizer fixture dump; usable on its own: `node gguf-metadata.mjs --model <gguf> --out artifact-fixture.json` |
| `prompts.json` | system text, three-language prompts, multi-turn, stop and template fixture inputs |
| `smoke.test.mjs` | unit tests + stub end-to-end run (no llama.cpp, no model) |

## Identity probe (PRD-006, PA-006)

`identity-probe.mjs` asks the locked model who it is — in English, French and
Hausa, several seeds each — using the app's **real** system instruction
(imported from `src/domain/chat/systemPrompt.ts`) and production sampling. It
fails when the model names itself "Aya" in more than 5 % of samples or says
"Namu" in fewer than 85 %.

```bash
llama.cpp-b10256/build/bin/llama-server -m ../artifacts/tiny-aya-global-q4_k_m.gguf -c 2048 -b 256 -ub 128 -t 4 -np 1 --jinja --port 8790
```

```bash
node model-release/desktop-smoke/identity-probe.mjs --seeds 1,2,3,4,5
```

Result for `namu-text-2` on 2026-09-17 (executed): 35 samples, "Namu" 33,
"Aya" 0. Run it again whenever the instruction, the artifact or the runtime
changes (EVAL-004).
