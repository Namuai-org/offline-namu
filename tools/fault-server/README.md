# Namu fault-injection server

Dependency-free Node HTTP server for the M3 transfer tests (PRD section 20,
T03–T07 and T12). With no fault rules it is a *correct* origin that behaves like
the production distribution; every defect is opt-in, per request path.

```bash
# 1. build a served tree from any local GGUF (or a synthesized fixture)
node model-release/dev/make-fixture-gguf.mjs --out /tmp/fixture.gguf --payload-bytes 52428800
node model-release/dev/make-dev-bundle.mjs --model /tmp/fixture.gguf --quantization F32

# 2. serve it
node tools/fault-server/server.mjs --root model-release/dev/out/serve --port 8787
```

Internal (`.internal`) debug builds may point `MODEL_ORIGIN` at
`http://10.0.2.2:8787` (Android emulator) or `http://localhost:8787` (iOS
simulator). For a physical device add `--host 0.0.0.0` and use the machine's
LAN address; release builds refuse any non-HTTPS origin.

## Correct behaviour (no rules)

| Aspect | Behaviour |
|---|---|
| Methods | `GET` and `HEAD` only; anything else is `405` with `Allow: GET, HEAD` |
| `ETag` | strong, quoted SHA-256 of the file: `"<64 hex>"` (cached by size + mtime) |
| Lengths | exact `Content-Length`; `Accept-Ranges: bytes` |
| `Range` | single `bytes=a-b`, `bytes=a-`, `bytes=-n` → `206` with exact `Content-Range: bytes a-b/size`; last position clamped to EOF |
| Unsatisfiable | first position ≥ size, or `bytes=-0` → `416` with `Content-Range: bytes */size` |
| Ignored `Range` | invalid syntax, reversed, multi-range, other units, or any `Range` on `HEAD` → `200` full (RFC 9110 §14.2) |
| `If-Range` | strong comparison with the current ETag; a different, weak (`W/`) or date validator → `200` full, never `206` |
| Metadata | `/models/*`: `application/octet-stream`, `Cache-Control: public,max-age=31536000,immutable`; `/releases/*`: `application/json`, `public,max-age=300` — the same values production uses, so `model-release/publish/validate-distribution.mjs` passes against both |
| Safety | serves regular files under `--root` only; `..`, encoded traversal and symlinks leaving the root are `404` |
| Logging | one line per request: method, path, range, if-range, status, body bytes sent, fault. **Query strings are dropped and never logged** |

## Fault rules

A rule is a JSON object. The first live rule that matches a request is applied
and its `times` counter is decremented.

| Field | Meaning |
|---|---|
| `match` | `"*"` (default) or a path pattern starting with `/`; `*` matches any run of characters, e.g. `"/models/*"` |
| `fault` | one of the modes below |
| `times` | apply to the next N matching requests, then expire; omit for unlimited |
| `whenRange` | `true`: only requests with a `Range` header (resumes); `false`: only requests without; omit for both |
| `methods` | default `["GET"]`; add `"HEAD"` to affect HEAD too |

| `fault` | Parameters | Effect |
|---|---|---|
| `drop` | `percent` (0–100) **or** `afterBytes` | full `Content-Length` promised, connection **reset** after that share of this response's body |
| `truncate` | `percent` **or** `afterBytes` | full `Content-Length` promised, body ends early with a clean close |
| `ignore-range` | — | `Range`/`If-Range` ignored: always `200` with the whole file |
| `wrong-content-range` | `variant`: `"start"` (default) or `"total"` | `206` whose `Content-Range` start is off by one, or whose total is size + 1 (range requests only) |
| `change-etag` | `ifRange`: `"ignore"` (default) or `"honor"` | a different ETag on every response. `ignore`: a broken origin that still answers `206`; `honor`: a correct origin whose object changed, so `If-Range` fails and it answers `200` |
| `status-416` | — | always `416` with `Content-Range: bytes */size` |
| `oversize` | `extraBytes` (default 1 MiB), `declareLength` (default `false`) | chunked body = file + extra bytes; with `declareLength: true` the true `Content-Length` is declared and more bytes are written anyway |
| `endless` | `maxBytes` (optional cap on the extra bytes) | chunked body that never ends until the client disconnects |
| `throttle` | `bytesPerSecond` | slow but correct response |
| `status` | `code` (400–599), `retryAfter` (seconds, optional) | that status, with `Retry-After` when given |
| `redirect` | `location` (absolute URL) **or** `altPort: true`; `code` (default 302) | off-origin redirect. `altPort` needs `--alt-port N`: a second listener (a different origin) that really serves the same bytes |
| `gzip` | — | `200`, `Content-Encoding: gzip`, compressed chunked body, `Range` ignored |

### Selecting faults

Command line (repeatable), or a file containing `{"rules": [...]}`:

```bash
node tools/fault-server/server.mjs --port 8787 \
  --fault '{"match":"/models/*","fault":"drop","percent":50,"times":1}'
node tools/fault-server/server.mjs --faults-file my-rules.json
```

At run time through the control endpoint, **localhost only** (other peers get
`403`; `Content-Type: application/json` is required so a web page cannot drive
it):

```bash
# replace all rules
curl -s -X POST -H 'Content-Type: application/json' http://127.0.0.1:8787/__faults \
  -d '{"rules":[{"match":"/models/*","fault":"status","code":503,"retryAfter":5,"times":3}]}'
curl -s http://127.0.0.1:8787/__faults           # rules with remaining/hits + the last 500 requests
curl -s -X DELETE http://127.0.0.1:8787/__faults  # clear rules and the request log
```

`GET /__faults` is the evidence source for a test run: it shows exactly which
`Range`/`If-Range` headers the app sent and how many body bytes each response
delivered.

## Recipes by PRD test ID

`M` stands for `"match":"/models/*"`. Post the rules, then drive the app.

| Test | Rules | Expected app behaviour (PRD / native contract §6) |
|---|---|---|
| **T03** drop at 10 % / 50 % / 99 % | `[{M,"fault":"drop","percent":10,"whenRange":false,"times":1}]` (then 50, 99) | Android: keeps durable bytes, resumes with `Range: bytes=P-` + `If-Range: "<etag>"`, final length and SHA-256 correct; the log shows a `206` starting at `P`. iOS: resumes from resume data or visibly restarts from zero (`TRANSFER_RESTART`); bytes are never blindly concatenated |
| T03 repeated drops | `[{M,"fault":"drop","percent":30}]` (unlimited) | every resume loses connectivity again; progress resets the retry counter, no corruption; clear the rule to let it finish |
| **T04** `200` to a `Range` request | `[{M,"fault":"drop","percent":50,"whenRange":false,"times":1},{M,"fault":"ignore-range","whenRange":true}]` | staging truncated to 0, `restartedFromZero`, processed as a fresh transfer; final length/hash correct; never appended |
| **T05** wrong `Content-Range` start | `[{M,"fault":"drop","percent":50,"whenRange":false,"times":1},{M,"fault":"wrong-content-range","variant":"start","times":1}]` | `206` discarded, truncate and restart; no activation of bad bytes |
| **T05** wrong `Content-Range` total | same with `"variant":"total"` | as above |
| **T05** changed ETag | `[{M,"fault":"drop","percent":50,"whenRange":false,"times":1},{M,"fault":"change-etag","whenRange":true,"times":1}]` | `206` with a different ETag is rejected → restart. With `"ifRange":"honor"` the server answers `200` and the app restarts from zero |
| **T05** truncated body | `[{M,"fault":"truncate","percent":60,"times":1}]` | durable bytes kept, retried per DL-007; a short file never reaches verification as complete |
| **T06** `416`, local file complete | download fully with the app paused before verification (or kill it right after the last byte), then `[{M,"fault":"status-416"}]` and resume | local length == expected → go to verifying; hash decides |
| **T06** `416`, local file incomplete | `[{M,"fault":"drop","percent":50,"whenRange":false,"times":1},{M,"fault":"status-416","whenRange":true,"times":1}]` | truncate and restart from zero |
| **T07** endless body | `[{M,"fault":"endless"}]` | abort at the signed size bound, staging deleted, `FILE_DAMAGED`; free-space reserve and current model preserved. The log line's `bytes=` shows how far the client read |
| **T07** oversized body | `[{M,"fault":"oversize","extraBytes":1048576}]` and again with `"declareLength":true` | same as endless; never more than `expected_bytes` written |
| **T12** iOS force-quit | `[{M,"fault":"throttle","bytesPerSecond":2000000}]` to keep the transfer running long enough; force-quit; relaunch | tasks reconciled with the journal; UI never promises automatic continuation; restart from zero is labelled |
| DL-007 retry/back-off | `[{M,"fault":"status","code":503,"times":3}]`; also `408`, `429`, `500`; add `"retryAfter":20` | back-off 2/5/15/30/60 s (+≤20 % jitter), `Retry-After` honoured up to 15 min, five consecutive failures → `TRANSFER_RETRY`. `{"code":403}` must **not** auto-retry |
| DL-003 off-origin redirect | start with `--alt-port 8788`; `[{M,"fault":"redirect","altPort":true}]` (or `"location":"https://<another host>/…"`) | redirect rejected; nothing is downloaded from the other origin (the alt listener's log stays empty) |
| DL-003 content encoding | `[{M,"fault":"gzip"}]` | response rejected (`Content-Encoding` other than identity) |
| Update check failures (T29 companion) | `[{"match":"/releases/stable.json","fault":"status","code":500}]` or `truncate`/`drop` on the same path | `checkForUpdate` reports an error; installed model keeps working |

Signature, sequence and expiry cases (T08, T29, T30) are data problems, not
transport faults: serve a different `releases/stable.json` (see
`model-release/test-vectors/`), no rule needed.

## Tests

```bash
node --test tools/fault-server/                       # directory form (uses run-tests.mjs)
node --test "tools/fault-server/**/*.test.mjs"        # equivalent glob form
```

The suite starts the server on an ephemeral port with a temporary file and
asserts the range, `If-Range`, `416`, method, traversal, logging, control
endpoint and every fault behaviour above.
