# model-release

Release tooling for the one model Namu ships: Cohere Labs **Tiny Aya Global**,
official **Q4_K_M** GGUF (`CohereLabs/tiny-aya-global-GGUF`,
`tiny-aya-global-q4_k_m.gguf`). Nothing in this directory is part of the
mobile app; Python and Node are release tools only (PRD sections 5–7).

```
acquire → lock → desktop smoke → dev bundle (internal builds)
                              ↘ publish (artifact → validate → descriptor) → app build config
```

| Path | Purpose |
|---|---|
| `acquire.py`, `requirements.lock.txt` | MDL-003 acquisition and the exact release-tool environment |
| `model.lock.json` | **created by `acquire.py`**, committed; upstream commit, exact bytes, SHA-256. It does not exist until the owner has authorized model use and someone has run the acquisition. It is never written by hand |
| `artifacts/` | the downloaded GGUF (git-ignored, ~2.14 GB) |
| `descriptor/` | `sign.mjs` (signer), `verify.mjs` (reference verifier), `strict-json.mjs` (duplicate-key-rejecting parser) |
| `test-vectors/` | shared descriptor conformance vectors for the Node, Kotlin and Swift verifiers |
| `dev/` | development trust bundle from any local GGUF, a synthesized structural fixture, bounded GGUF header reader |
| `inspect-header.mjs`, `runtime-fixture.json` | INF-002/003 runtime fixture (chat template, special and control tokens, stop markers) read from the upstream GGUF **header only** via range requests, and compiled into the app. Maintained with the inference adapter (`docs/engineering/runtime-contract.md`), not by the publication tooling |
| `desktop-smoke/` | MDL-006 smoke test against llama.cpp `b10256`; also cross-checks `runtime-fixture.json` against the locked, fully downloaded artifact |
| `publish/` | preflight, upload, distribution validation, descriptor verification and publication (DST-002/003) |

Runbooks: `docs/runbooks/model-publication.md`, `docs/runbooks/signing-keys.md`.
Infrastructure: `infra/`. Fault injection: `tools/fault-server/`.

## 1. Acquire and lock (MDL-001 … MDL-005)

Precondition: written authorization covering Namu's intended use and
redistribution (PRD-007). Tiny Aya's published terms are non-commercial; a
free download is not an exemption. Without it, stop here.

```bash
python3 -m venv .venv-model-release
.venv-model-release/bin/python -m pip install -r model-release/requirements.lock.txt
.venv-model-release/bin/python model-release/acquire.py
```

* `requirements.lock.txt` is the exact `pip freeze` of an isolated environment
  with `huggingface_hub` (resolved once: `huggingface_hub==1.32.0` on Python
  3.14). Later acquisitions install **from this file**; they do not resolve
  again. To change it, recreate a clean venv, `pip install huggingface_hub`,
  `pip freeze > model-release/requirements.lock.txt`, and review the diff.
* `acquire.py` downloads **only** the Q4_K_M file, from a full 40-hex upstream
  revision, checks size and SHA-256 against the Hub's LFS metadata, and writes
  `model.lock.json`. No other file, quantization or weight format is fetched;
  no conversion or quantization is done; the tokenizer and chat template are
  inside the GGUF (MDL-001).

Rules (MDL-004, MDL-005):

* Commit `model.lock.json`, `acquire.py` and `requirements.lock.txt`. Never
  commit artifact bytes or access tokens (`artifacts/`, `.venv-model-release/`
  and `*.pem` are git-ignored). If the Hub requires login or licence
  acceptance, do it in the authorized developer's release environment; a
  Hugging Face token is never embedded in the app, CI or this repository.
* A later acquisition **reuses the locked revision** (the script does this
  whenever a lock exists, and fails if anything differs). CI never refreshes
  `main`, and no CI job downloads the model.
* A new upstream revision is a new release: new lock, new signed descriptor,
  the whole model qualification suite again (section 21), and a PRD-tracked
  change. Do not delete the old lock from history: rollbacks need it.
* No guessed checksum, abbreviated revision or rounded byte count may appear
  anywhere. "2.14 GB" is a description, never an integrity value.

## 2. Desktop smoke test (MDL-006)

`desktop-smoke/README.md`. Run it once per lock, before mobile work depends on
the artifact; it also produces the template and stop-token fixtures used by
the adapter tests.

## 3. Development bundle (internal builds only)

```bash
# real artifact, or any small redistributable GGUF, or a synthesized structural fixture:
node model-release/dev/make-fixture-gguf.mjs --out /tmp/fixture.gguf
node model-release/dev/make-dev-bundle.mjs --model /tmp/fixture.gguf --quantization F32
node tools/fault-server/server.mjs --root model-release/dev/out/serve --port 8787
```

`make-dev-bundle.mjs` signs with a throwaway `dev-` key and writes the three
trust files into `dev/out/` and into the Android assets and iOS bundle
configuration directories; `--out-only` skips the native directories and
`--out <dir>` changes the output directory (tests, CI). The synthesized fixture
is structurally valid GGUF but **not a loadable model**; release builds accept
only `cohere2`/`Q4_K_M` and refuse `dev-` keys, and no fixture ever becomes a
user-visible model (REL-001). See `dev/README.md`.

## 4. Publish

Follow `docs/runbooks/model-publication.md`. The order is fixed (DST-003):

1. `publish/preflight.mjs` — lock complete, local bytes and SHA-256 match.
2. `publish/upload-artifact.mjs` — single `PutObject` to
   `models/aya-global-q4km/<sha256>/model.gguf` with
   `application/octet-stream`, no `Content-Encoding`,
   `Cache-Control: public,max-age=31536000,immutable`, S3-verified SHA-256,
   never overwriting; then `head-object` verification. ETags are never treated
   as SHA-256.
3. `publish/validate-distribution.mjs --full` — HEAD, range (start, middle,
   last byte, open-ended), beyond-EOF `416`, `If-Range` with right and wrong
   ETag, and the full streamed SHA-256, through the CloudFront origin.
4. `descriptor/sign.mjs` then `publish/verify-descriptor.mjs`.
5. `publish/publish-descriptor.mjs` — refuses without a passing `--full`
   report and a strictly higher sequence; `Cache-Control: public,max-age=300`.

Rollback = a new higher-sequence descriptor for an earlier known-good lock
(SIG-005, REL-006).

Which steps touch what:

| Tool | Local files | HTTP(S) GET/HEAD | AWS CLI (publisher role) |
|---|---|---|---|
| `preflight.mjs`, `verify-descriptor.mjs`, `sign.mjs` | yes | no | no |
| `validate-distribution.mjs` | yes | yes | no |
| `upload-artifact.mjs` | yes | no | `s3api put-object`, `s3api head-object` |
| `publish-descriptor.mjs` | yes | yes | `s3api put-object`, optional `cloudfront create-invalidation` |

Every AWS command goes through one function (`publish/lib.mjs` `runAws`) and
can be printed without running via `--dry-run`. None of the AWS paths has been
executed by the author.

## Tests

```bash
node --test model-release/                  # directory form (package.json "main" → run-tests.mjs)
node --test "model-release/**/*.test.mjs"   # equivalent glob form
```

Covers the strict JSON parser, every shared descriptor vector, sign → verify,
key rotation and rollback rules, the dev bundle against a synthesized GGUF,
the publication tools against the local fault server (AWS in `--dry-run`), and
the desktop smoke tooling against stubs. No network, no AWS, no model.

On Node 22+ a bare directory argument to `node --test` is executed as a
program rather than searched, which is why `package.json` points `main` at
`run-tests.mjs`; the glob form needs neither.
