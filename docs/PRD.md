# Namu Offline v1 — Product requirements and engineering specification

Version 1.0 · 17 September 2026 · Implementation baseline

**Product:** Namu. **Platforms:** Android and iOS. **Model:** Cohere Labs Tiny Aya Global, official Q4_K_M GGUF only. **Delivery:** one shared React Native application with native inference and download services.

This specification supersedes the earlier architecture study wherever they differ. MUST requirements are release requirements. The numbered implementation sequence in section 23 is the execution order. Numeric defaults below are product decisions; performance thresholds are acceptance targets, not measured results. This document specifies the product to build; it does not claim that the app or selected dependency combination has already passed device testing.

## 1. Product contract

**PRD-001.** After a one-time model installation, users MUST be able to start the app, create conversations, receive text answers, read history, change local settings and delete data without network access.

**PRD-002.** The application MUST expose one assistant. There MUST be no model catalog, model selector, quantization selector, Hugging Face login, runtime selector or sampling settings in the production UI.

**PRD-003.** V1 MUST support text chat, streamed answers, stopping, retrying the latest answer, local conversation search, rename, deletion, and explicit text export. Translation and summarization are starter prompts using the same model, not separate products.

**PRD-004.** V1 MUST ship human-reviewed interface strings in Hausa, French and English. Response-language settings are Same as my message, Hausa, French and English. Model quality in each language MUST pass section 21 before release.

**PRD-005.** V1 excludes voice, images, document attachments, web browsing, RAG, tools/device actions, accounts, cloud inference, conversation synchronization, payments, arbitrary model import and background answer generation. Do not create placeholder screens for these features.

**PRD-006.** Namu owns the product identity. Cohere/Tiny Aya attribution MUST remain available in About the AI. Do not describe Aya as a model trained by Namu.

**PRD-007.** Tiny Aya's public model card and GGUF repository specify non-commercial terms; commercial use requires appropriate authorization. The project owner MUST retain written evidence of rights covering Namu's intended use and redistribution before that use or public model hosting. A free download is not an automatic exemption. Engineers MUST NOT substitute another model without a revised PRD. This is a release dependency, not a runtime architecture choice. [D01, D02]

## 2. Fixed implementation stack

| Component | Required implementation |
|---|---|
| Project | Bare React Native; native Android and iOS projects committed |
| React Native | 0.86.0, New Architecture, Hermes; React version from that exact official template |
| Language | TypeScript strict mode; Kotlin for Android native services; Swift for iOS native services |
| UI | React Native Paper 5.x, themed through Namu components; React Native core FlatList for histories |
| Navigation | React Navigation 7.x: native stack plus three bottom tabs |
| UI state | Zustand 5.x; transient state only |
| Inference | llama.rn **0.12.9**, exact pin; its bundled llama.cpp revision, not a separately upgraded runtime |
| Persistence | @op-engineering/op-sqlite, local SQLite; parameterized SQL, ordered migrations, no ORM |
| Localization | i18next + react-i18next; bundled JSON resources |
| Markdown | markdown-it with HTML disabled; Namu-owned React Native token renderer |
| Android transfer | OkHttp inside UIDT JobService on API 34+; foreground WorkManager worker on API 29–33 |
| iOS transfer | Background URLSessionDownloadTask with a stable session identifier |
| Transfer journal | Platform-native SQLite database, separate from chat DB, owned exclusively by transfer service |
| Integrity | Native streaming SHA-256; Ed25519 descriptor verification with Android Tink and iOS CryptoKit |
| Distribution | Private Amazon S3 bucket in eu-west-1, CloudFront with Origin Access Control, HTTPS |
| Infrastructure definition | Terraform; separate staging and production resources |
| CI | GitHub Actions; Android Linux runner and supported macOS/Xcode runner for iOS |
| Testing | Jest, React Native Testing Library, Maestro, native platform tests, real-device benchmark harness |

**STK-001.** Dependency bootstrap MUST resolve stable versions within the selected major lines once, save exact versions with no caret/tilde in direct dependencies and commit package-lock.json, Podfile.lock, Gradle wrapper and Gradle dependency verification metadata. Record Node, npm, Java, Xcode, SDK, NDK and CMake versions in `toolchain.lock.md`. Use the exact RN template's toolchain first; validate store submission requirements before release.

**STK-002.** The selected llama.rn release is the stable 0.12.9 release reviewed for this PRD. Its release notes identify llama.cpp b10256. Do not use the 0.13 release candidates or floating main. The first milestone MUST prove the exact RN/runtime combination on both platforms; a dependency defect blocks that milestone until fixed and documented. [D04, D05]

**STK-003.** Commit native artifact checksums and retain native symbols. Use the package's matching native binaries with their integrity checks. Do not fetch executable components after app installation. Native integration documentation is referenced in section 24. [D04]

**STK-004.** Use the application ID `org.namuai.offline` on both platforms, subject to registration in Namu's developer accounts. Internal builds use `.internal` suffix. Display name is Namu. Do not provision accounts or publish stores as part of writing this PRD.

## 3. Platform and device policy

**DEV-001.** Minimum OS is Android 10 / API 29 and iOS 17. Release Android ABI is arm64-v8a; iOS is arm64. Emulators/simulators are for functional UI tests only.

**DEV-002.** V1 targets phones in the 6 GB RAM class and above. The native preflight MUST require reported physical memory of at least 5,000,000,000 bytes; this is a conservative eligibility filter accounting for reported/reserved memory, not a performance certification. Lower-memory devices MUST receive a compatibility explanation before downloading. Do not offer an experimental 4 GB mode.

**DEV-003.** Eligibility also requires sufficient disk space and successful post-install self-test. An eligible device is not officially supported until its device class passes the sustained release tests. A 6 GB label alone MUST NOT be advertised as a guarantee.

**DEV-004.** Android inference backend is CPU only. iOS inference backend is Metal, with zero silent CPU fallback: if Metal initialization fails, preserve chats and show an unsupported-runtime error. Android GPU/NPU acceleration is outside v1.

**DEV-005.** All native Android libraries MUST support 16 KB memory pages. Validate the packaged release artifact and run a 16 KB emulator test. [D14]

**DEV-006.** Support portrait and landscape. Larger displays use the same single-column UI, centered with maximum content width 720 logical pixels. Respect safe areas, system back behavior and keyboard insets.

## 4. Required repository boundaries

| Path | Responsibility |
|---|---|
| `src/app/` | Composition root, navigation, lifecycle integration |
| `src/features/setup/` | Language, consent, device check, transfer status |
| `src/features/chat/` | Composer, messages, answer status, actions |
| `src/features/conversations/` | Paginated list, search, rename, delete |
| `src/features/settings/` | Preferences, storage, privacy, help and attribution |
| `src/domain/chat/` | ChatSessionController, prompt budgeting, generation rules |
| `src/domain/inference/` | Engine contract and typed failures |
| `src/data/` | Chat SQLite schema, migrations and repositories |
| `src/infrastructure/inference/` | Only location importing llama.rn |
| `src/infrastructure/platform/` | Typed native service adapters |
| `src/design/` | Tokens, Namu components, icons, fonts |
| `src/locales/` | en, fr, ha JSON and translation checks |
| `android/`, `ios/` | Platform integrations and transfer journal |
| `model-release/` | Artifact acquisition, descriptor generation, validation tools |
| `infra/` | Terraform for distribution |
| `tests/`, `e2e/`, `benchmarks/` | Automated tests, device journeys and workload fixtures |
| `docs/` | PRD, dependency lock, release evidence and engineering decisions |

**ARC-001.** Components MUST call controllers/repositories. They MUST NOT import llama.rn, perform SQL, build model URLs or access native file paths.

**ARC-002.** ChatSessionController MUST be application-scoped. One active model context and one active generation are permitted. UI navigation does not own the context.

**ARC-003.** The transfer service MUST run without a JS runtime. Its SQLite journal is authoritative for transfer progress; the durable active pointer specified in DL-012 is authoritative for model activation. Startup reconciliation derives installed state from that pointer and repairs the journal mirror. React Native subscribes to snapshots; Zustand mirrors visible progress but cannot declare an artifact installed.

**ARC-004.** The chat database is authoritative for conversations. Do not persist entire histories into Zustand or duplicate model blobs in SQLite. No network call is allowed in the chat execution dependency path.

## 5. Exact model selection and acquisition

Use this artifact only:

| Field | Value |
|---|---|
| Publisher | Cohere Labs |
| Repository | `CohereLabs/tiny-aya-global-GGUF` |
| File | `tiny-aya-global-q4_k_m.gguf` |
| Format / architecture | GGUF / cohere2 |
| Quantization | Q4_K_M |
| Approximate published size | 2.14 GB decimal; never use this rounded value for integrity checks |
| Product model ID | `namu-aya-global` |
| Release family | `aya-global-q4km` |

**MDL-001.** Download the official GGUF. Do not download all repository files, PyTorch/safetensors weights, Q4_0, Q8_0, BF16 or F16. No conversion or quantization is required for v1. The tokenizer and template are carried by the selected GGUF; do not invent a separate tokenizer download. [D02]

**MDL-002.** Model detail page: [exact Q4_K_M file](https://huggingface.co/CohereLabs/tiny-aya-global-GGUF/blob/main/tiny-aya-global-q4_k_m.gguf). Documentation: [Hub file download guide](https://huggingface.co/docs/huggingface_hub/guides/download) and [HfApi metadata reference](https://huggingface.co/docs/huggingface_hub/package_reference/hf_api). These are developer references; users download from Namu's distribution endpoint. [D02, D03]

**MDL-003.** First create `model-release/model.lock.json` using the acquisition procedure below. The lock MUST contain the full upstream commit, exact byte count and SHA-256. The web listing was insufficient to establish those exact fields during preparation of this PRD. They MUST be fetched and verified; no guessed checksum, abbreviated revision or rounded byte count may enter a build.

The engineer MUST implement and run the following as `model-release/acquire.py`, after the intended use is authorized. Install huggingface_hub in an isolated release-tool environment and record its exact resolved version. Python is a release tool only; it is not part of the mobile app.

```python
import hashlib
import json
import re
from pathlib import Path
from huggingface_hub import HfApi, hf_hub_download

repo = "CohereLabs/tiny-aya-global-GGUF"
filename = "tiny-aya-global-q4_k_m.gguf"
lock_path = Path("model-release/model.lock.json")
api = HfApi()

# Existing releases always reuse the locked revision.
old = json.loads(lock_path.read_text()) if lock_path.exists() else None
revision = old["revision"] if old else api.model_info(repo).sha
if not revision or not re.fullmatch(r"[0-9a-f]{40}", revision):
    raise RuntimeError("A full immutable upstream revision is required")
info = api.model_info(repo, revision=revision, files_metadata=True)
if info.sha != revision:
    raise RuntimeError("Upstream revision mismatch")
entry = next(s for s in info.siblings if s.rfilename == filename)
if entry.size is None or entry.lfs is None:
    raise RuntimeError("Exact upstream size/SHA-256 unavailable; do not release")
expected_bytes = entry.size
expected_sha = entry.lfs.sha256
if expected_bytes <= 0 or not re.fullmatch(r"[0-9a-f]{64}", expected_sha):
    raise RuntimeError("Invalid upstream size or SHA-256")

path = Path(hf_hub_download(
    repo_id=repo, filename=filename, revision=revision,
    local_dir="model-release/artifacts"
))
if path.stat().st_size != expected_bytes:
    raise RuntimeError("Downloaded size mismatch")
digest = hashlib.sha256()
with path.open("rb") as stream:
    for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
        digest.update(chunk)
if digest.hexdigest() != expected_sha:
    raise RuntimeError("Downloaded SHA-256 mismatch")
lock = {
    "schema": 1, "repo_id": repo, "revision": revision,
    "filename": filename, "bytes": expected_bytes,
    "sha256": expected_sha, "architecture": "cohere2",
    "quantization": "Q4_K_M"
}
if old is not None and old != lock:
    raise RuntimeError("Artifact metadata differs from existing lock")
lock_path.write_text(json.dumps(lock, indent=2) + "\n")
print(path)
```

Run from the repository root using the following release-tool setup. Commit `model-release/requirements.lock.txt` alongside the model lock; subsequent acquisitions install from that requirements file rather than resolving dependencies again. These commands download approximately 2.14 GB and require enough local space for the release artifact and the Hub cache.

```bash
python3 -m venv .venv-model-release
.venv-model-release/bin/python -m pip install huggingface_hub
.venv-model-release/bin/python -m pip freeze > model-release/requirements.lock.txt
.venv-model-release/bin/python model-release/acquire.py
```

**MDL-004.** Commit the lock and acquisition tool; exclude artifact bytes and access tokens from git. If the Hub requires acceptance or authentication, use the authorized developer's release environment. Never embed a Hugging Face token in the mobile app.

**MDL-005.** For a subsequent acquisition, use the same locked revision. A new upstream revision requires a new release descriptor and the entire model qualification suite. Do not refresh `main` during CI builds.

**MDL-006.** Run a desktop smoke test with the selected runtime family and then the mobile app. Verify Hausa, French, English, multi-turn formatting and stop behavior. Desktop success does not replace mobile testing.

## 6. Distribution infrastructure

**DST-001.** Provision a private S3 Standard bucket with versioning and public access blocked. CloudFront accesses the bucket through Origin Access Control. Public clients access only CloudFront over HTTPS. Region is eu-west-1. Infrastructure resource names and the assigned distribution domain are captured from Terraform outputs rather than invented in source. [D08]

**DST-002.** The artifact object key is `models/aya-global-q4km/<sha256>/model.gguf`. Object metadata MUST include `Content-Type: application/octet-stream`, exact Content-Length, no Content-Encoding, and `Cache-Control: public,max-age=31536000,immutable`. Do not ZIP, gzip or transform the model.

**DST-003.** Publish the artifact first, verify full and range downloads from CloudFront, then publish `releases/stable.json` with a 300-second cache TTL. Use the distribution domain as `MODEL_ORIGIN` in the build configuration. Upload a byte-identical artifact; AWS ETags MUST NOT be treated as SHA-256. CloudFront range semantics are documented in D09.

**DST-004.** Serving infrastructure needs no app login, device identifier, user database or inference API. Accept GET and HEAD only. Separate release-publishing credentials from read delivery. Store no AWS credentials in the app.

**DST-005.** Enable operational alarms for 5xx responses and transfer spending. Retain access logs for seven days, restrict staff access, and disclose that model requests expose ordinary network metadata. Avoid stable user/device identifiers in URLs and headers. At 100,000 complete installations, the selected artifact implies approximately 214 TB delivered before retries; budget using measured regional delivery costs before promotion.

## 7. Signed release descriptor

**SIG-001.** Bundle the initial signed descriptor and Ed25519 public verification key in the app. Generate the signing key during release setup and store the private key only in the protected release environment. A public key and origin hostname are build configuration, not secrets.

**SIG-002.** The downloaded envelope is `{key_id, payload_b64, signature_b64}`. Sign the exact decoded UTF-8 payload bytes. Verify signature before parsing the payload. This avoids cross-platform JSON canonicalization ambiguity. Envelope maximum is 64 KiB; payload maximum is 32 KiB.

Required payload fields:

| Field | Type / rule |
|---|---|
| `schema` | Integer, exactly 1 |
| `sequence` | Positive monotonic integer |
| `model_id` | Exactly `namu-aya-global` |
| `artifact_version` | Immutable release identifier |
| `path` | Relative immutable artifact path; no traversal, query or other origin |
| `bytes`, `sha256` | Exact verified lock values |
| `upstream_repo`, `upstream_revision`, `upstream_filename` | Match model.lock.json |
| `architecture`, `quantization` | cohere2 and Q4_K_M |
| `runtime_build_ids` | Explicit allowed Namu runtime build IDs |
| `min_app_build`, `max_app_build` | Inclusive integer range |
| `prompt_version` | Bundled prompt version understood by this app |
| `license_notice_id` | Bundled notice ID; no remotely injected legal text |
| `issued_at`, `expires_at` | UTC timestamps; 180-day validity for remote metadata |

**SIG-003.** Unknown fields may be ignored only after signature verification; missing required fields, duplicate JSON keys, unknown schema or incompatible runtime MUST reject the descriptor. Store the highest accepted sequence in the native journal. Reject lower sequences. Same sequence with different payload hash MUST fail.

**SIG-004.** Expired remote descriptors cannot authorize a new update. Existing installed models continue working. The bundled initial descriptor remains an app-trusted recovery source for its exact digest, subject to the app's local known-bad artifact list. An app-store update rotates signing keys; v1 does not implement remote key replacement.

**SIG-005.** Check for updates only when the user selects Check for updates in Offline storage. Never require an update check to open chat. Never automatically start a multi-gigabyte transfer. A later descriptor can point to an earlier known-good artifact using a new higher sequence; signed rollback authorization is distinct from accepting replayed metadata.

## 8. Transfer, installation and storage protocol

**DL-001.** Native transfer service exposes `start`, `pause`, `resume`, `cancel`, `snapshot`, `checkForUpdate`, `activate`, `removeModel`. Calls are idempotent by transfer ID. Only one transfer per artifact may exist. Progress events to JS are coalesced to four per second.

**DL-002.** Transfer journal fields include transfer ID, descriptor bytes/hash, artifact version, phase, expected bytes/hash, committed bytes, ETag, staged filename, OS task ID, metered-network consent, retry count, last error and timestamps. Do not store chats in this journal.

**DL-003.** Android uses OkHttp with transparent content encoding disabled and `Accept-Encoding: identity`. Initial GET expects 200. Resume sends Range and If-Range with a strong ETag. Append only for 206 with exact start offset, valid total length and matching object identity. On 200 to a resume request, truncate staging and process as a fresh transfer; never append. For 416, verify a complete local file if its length equals expected bytes, otherwise restart. Reject oversized, malformed, truncated or off-origin redirected responses. [D09]

**DL-004.** Android writes to `.part`, flushes/journals every 4 MiB or 2 seconds, whichever occurs first, and on graceful stop. Advance committed offset only after durable file flush. On restart truncate bytes beyond the last committed offset and resume. Do not attempt to serialize a hash implementation's internal state; rehash the complete file after download.

**DL-005.** iOS uses one background session with a stable bundle-derived identifier, delegate callbacks and a serial delegate queue. Persist task identifiers and opaque resume data. Reconnect to tasks after OS relaunch; move completed temporary files into durable staging inside the completion callback. Do not interpret or edit Apple's resume data. If resume data is unavailable or rejected, visibly restart downloading from zero; preserve the old installed model. Do not promise automatic continuation after user force-quit. [D07]

**DL-006.** Wi-Fi/unmetered-only is the default. Cellular/metered use requires an explicit per-transfer confirmation showing remaining bytes. A new update requires new confirmation. Pause is persistent until the user resumes; loss of network produces waiting status. No hidden automatic retries after cancellation.

**DL-007.** Retry transient transport failures and 408/429/5xx at 2, 5, 15, 30 and 60 seconds with up to 20% jitter; respect Retry-After up to 15 minutes. After five failures enter user-retry-required. No automatic retries for signature, hash, compatibility or 4xx authorization errors. Stop accepting bytes above the signed length.

**DL-008.** Native storage roots are Android `noBackupFilesDir/namu-models` and iOS `Library/Application Support/NamuModels` with backup exclusion. Staging and releases reside on the same volume. Paths use app-generated IDs only. Installed files are immutable and read-only to normal application operations.

**DL-009.** Let B be expected bytes and P durable partial bytes. Require additional free space of at least `(B-P) + 1 GiB` before transfer/resume. Existing installed bytes are already excluded from reported free space and MUST NOT be counted twice. On iOS include any separate temporary/import copy in the requirement if the implementation cannot guarantee same-volume movement. Recheck during transfer and before activation. Pause if reserve falls below 256 MiB. Preserve the current model.

**DL-010.** Installation sequence is: trusted descriptor → space check → transfer → exact length → streaming SHA-256 → structural GGUF metadata check → release directory rename → foreground self-test → atomic active-pointer replacement → native-journal commit. Self-test uses no user content. Never invoke the native GGUF parser on a file that has not passed hash verification.

**DL-011.** Prior to self-test, cancel/await existing generation and release its context. Do not hold old and new model contexts together. Self-test allocates the production context, formats a fixed 128-token fixture and generates 32 deterministic tokens. A valid nonempty result with no leaked control tokens is required. A failure keeps the old active pointer and reloads old weights only on explicit user action.

**DL-012.** `active.json` is the activation authority. Write a new pointer to a temporary file, flush it, and atomically replace the old pointer; use platform durable-write primitives and validate with crash injection. Pointer contains active and previous artifact IDs/digests plus trial state. The journal mirrors it. Recovery treats an unactivated verified release as staged, not installed. Record a pending activation marker before self-test; a crash quarantines that candidate on next launch.

**DL-013.** Retain one previous version for seven days and until three successful foreground sessions on the new version. Do not delete an artifact with a live runtime reference. Allow Restore previous version during this window. After successful qualification/retention, delete the previous version when idle. A failed trial marks the new digest locally bad and restores the previous pointer. If no previous version exists, open repair UI without automatic reload loops.

**DL-014.** At startup validate pointer, file existence and exact length without rehashing 2 GB on every launch. Rehash on explicit repair, failed native load or size/metadata anomaly. No background scan may delay reading chats.

**DL-015.** Transfer state and engine state MUST be separate. Transfer phases are absent, waiting, downloading, paused, verifying, staged, selfTesting, installed, failed and removing. Engine phases are unloaded, loading, ready, generating, stopping and error. A failed update does not change an existing installed model into absent.

Acceptance: interrupted, corrupt, incompatible and oversized transfers MUST never become active; failed updates MUST preserve working offline chat. [D06, D07]

## 9. Inference contract and production configuration

The following is a Namu-owned interface, not a claim about the exact signatures exposed by llama.rn. Implement its adapter against the pinned package's installed TypeScript types. [D04]

```typescript
type FinishReason = 'eos' | 'length' | 'cancelled' | 'interrupted' | 'error';
type EngineState = 'unloaded' | 'loading' | 'ready' | 'generating' | 'stopping' | 'error';
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
interface InferenceEngine {
  load(artifactId: string): Promise<void>;
  countFormattedTokens(messages: ChatMessage[]): Promise<number>;
  generate(request: {
    id: string; conversationId: string; messages: ChatMessage[];
  }, onText: (event: { requestId: string; sequence: number; delta: string }) => void)
    : Promise<{ requestId: string; text: string; reason: FinishReason }>;
  cancel(requestId: string): Promise<void>;
  unload(): Promise<void>;
  state(): EngineState;
}
```

| Setting | Required value |
|---|---|
| Context | 2,048 tokens including template, history and output |
| Maximum generated tokens | 384 per answer |
| Prompt ceiling | 1,632 formatted tokens; remaining 32 are a safety margin |
| Temperature / top_p / top_k | 0.3 / 0.9 / 40 |
| Repeat penalty | 1.1 |
| Production seed | Runtime random seed; record numeric seed only in local diagnostics when exposed |
| Test seed | 42 with deterministic test sampler configuration |
| CPU threads | min(4, reported logical CPU count) |
| Batch / micro-batch | 256 / 128 |
| KV cache | F16 K and V |
| mmap / mlock | Enabled / disabled |
| GPU layers | Android: 0; iOS: 99 to request full available Metal offload |
| Parallel requests | 1 |
| Context shifting | Disabled; Namu explicitly budgets each request |
| Speculation, embeddings, multimodal, tools | Disabled |

**INF-001.** Map each configuration field to the pinned API and assert accepted values in diagnostics. Do not silently omit an unsupported critical field. If the public binding does not expose a required control, implement it in a narrowly scoped, tested patch against the pinned native source and record the patch hash. This includes explicit session reset if needed.

**INF-002.** Format role messages using the GGUF's embedded template. Count the same formatted token sequence used for generation, including special tokens and the assistant prefix. Do not hand-concatenate roles. Validate template output against a reference render of the pinned model's template using fixtures for first turn, multi-turn, system message and multilingual input.

**INF-003.** Use the model metadata's end-of-generation behavior. Derive any required explicit stop markers from the locked tokenizer/template and save them in the runtime fixture. Do not copy a generic list of Llama/Qwen stop strings. Test that no Cohere role/control tokens appear in visible output.

**INF-004.** Reset per-conversation native session memory when switching conversations. For each generation provide the complete selected prompt; v1 disables cross-request KV reuse unless exact prefix correctness has been contract-tested. Resetting session state MUST preserve loaded weights. Extend the adapter's native reset operation if required; do not reload multi-gigabyte weights every turn.

**INF-005.** Native work MUST run off the main/JS thread. Decode bytes into valid UTF-8 before emitting text. Event sequence numbers MUST increase monotonically. The adapter MUST reject duplicate/out-of-order chunks and the controller MUST reject chunks for obsolete request IDs.

**INF-006.** One application-wide ownership lock serializes load, generation, activation and unload. Cancellation is an out-of-band cooperative signal: it MUST NOT wait behind the generation operation it is stopping. Cancellation uses the actual native stop mechanism, then waits for completion acknowledgement before releasing memory. After 5 seconds without acknowledgement, show stopping-failed, disable new generation and require reopening the app; never free a running context.

**INF-007.** Load lazily when the first message is sent. Unload after 120 seconds of foreground inactivity with no generation. On background transition, checkpoint, cancel and release as soon as acknowledged; OS suspension may prevent completion, so restart recovery is mandatory. Native memory/thermal events MUST reach the controller even when React screens are unmounted.

**INF-008.** At Android SEVERE thermal status or iOS serious/critical thermal state, stop the answer and unload after acknowledgement. Block new generation until a non-severe reading persists for 30 seconds. Unsupported sensors do not establish safety; use sustained device qualification. Do not poll thermal headroom more often than platform guidance permits. [D15]

## 10. Prompt, context and language rules

**CTX-001.** Bundle the following system instruction as `namu-text-1`. The template may also insert its own upstream preamble; verify the final combined prompt rather than duplicating it manually.

> You are Namu, a helpful assistant running on this device. Give clear, useful answers in simple language. Reply in the language of the user's latest message unless the response-language instruction below specifies another language. You do not browse the internet, access current news, inspect the device, or perform external actions. Do not claim to have done those things. If you do not know, say so. Do not invent sources or present uncertain information as fact. For important health, legal, financial or safety questions, explain relevant uncertainty and encourage appropriate qualified help. Use short paragraphs and simple Markdown. Keep answers concise unless the user asks for detail.

Append one fixed line: `Response language: match the latest user message.` or `Response language: Hausa.` / `French.` / `English.` according to the conversation setting. User text MUST never be interpolated into the system instruction.

**CTX-002.** Input limit is 12,000 Unicode code points for draft storage and rendering. Before accepting a send, tokenize its formatted prompt. If the system plus current message exceeds 1,632 tokens, retain the draft and display an instruction to shorten it. Never silently truncate the current user message.

**CTX-003.** Build context from the system prompt, newest complete user/selected-assistant turn pairs, and the current message. Remove oldest pairs until the formatted prompt fits. Include partial assistant text only when the user has proceeded past that turn, treating it as the selected answer; exclude empty failed attempts. No isolated assistant messages or duplicate user turns may enter the template.

**CTX-004.** Keep full history in SQLite. When context is trimmed, show a quiet notice: Earlier messages are saved, but may no longer be used in this answer. Do not summarize history automatically in v1.

**CTX-005.** A length-limited answer is saved with reason `length` and a visible limit label. There is no synthetic Continue button in v1; the user can send a normal follow-up asking for more. The model has no persistent memory beyond selected chat context.

**CTX-006.** Language changes affect the next answer, not existing text. App language and response language are independent. Do not run automatic language detection downloads or remote translation APIs.

## 11. Durable conversation lifecycle

**CHAT-001.** On Send, validate length and availability, then in one SQLite transaction create the user turn, first assistant-attempt record, generation attempt and updated conversation timestamp. Only after successful commit clear the composer and invoke inference. A failed transaction leaves the draft unchanged.

**CHAT-002.** Buffer text in the active-message component, publish UI deltas every 50 ms and checkpoint to SQLite every 1 second or 1 KiB of newly emitted text, whichever occurs first. Terminal results MUST be committed immediately. Process death may lose the latest uncommitted fraction of an answer; completed answers and accepted user messages must survive.

**CHAT-003.** Each generation ends exactly once as complete, stopped, interrupted or failed. Database updates use the generation ID and guarded state transition so a late completion cannot overwrite a cancellation or another attempt. On restart, pending/streaming/stopping attempts become interrupted; no automatic re-execution.

**CHAT-004.** Stop retains partial output. Try again is available only on the latest turn. It creates a new assistant attempt using the same user message, preserving old attempts. The newest successful/nonempty attempt becomes selected; if a retry fails empty, keep the old selection. Only the selected attempt enters later context.

**CHAT-005.** Once a new user turn is submitted, previous attempt selection is read-only. Editing old messages and branching conversations are outside v1. Copy and export remain available for all visible text.

**CHAT-006.** Navigating to Settings/Conversations leaves an active foreground generation owned by its original conversation. Show a Return to answer banner. Starting another answer or opening a different conversation for generation requires an explicit Stop current answer action. Do not create a hidden generation queue.

**CHAT-007.** A new conversation is created persistently on first successful send, not merely by tapping New chat. Store unsent new-chat drafts separately. Generated titles are not required: use the first 48 grapheme clusters of the initial user message, normalized to one line. User rename overrides this permanently.

## 12. SQLite schema and query contract

**DB-001.** Use one app-private `namu.sqlite` for content. Enable foreign keys, WAL, `synchronous=FULL` and a 5-second busy timeout. Use a single serialized async write queue. No synchronous database operations from render functions. Database, WAL and SHM files share the same backup-excluded directory. [D10]

Minimum schema:

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_is_custom INTEGER NOT NULL DEFAULT 0 CHECK(title_is_custom IN (0,1)),
  response_language TEXT NOT NULL DEFAULT 'auto'
    CHECK(response_language IN ('auto','ha','fr','en')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  user_text TEXT NOT NULL,
  selected_attempt_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(conversation_id, ordinal)
);
CREATE TABLE assistant_attempts (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN
    ('pending','streaming','stopping','complete','stopped','interrupted','failed')),
  finish_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(turn_id, attempt_number)
);
CREATE TABLE generations (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES assistant_attempts(id) ON DELETE CASCADE,
  artifact_sha256 TEXT NOT NULL,
  runtime_build_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  prompt_tokens INTEGER,
  output_tokens INTEGER,
  error_code TEXT,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE TABLE drafts (
  draft_key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE preferences (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
CREATE INDEX conversations_recent ON conversations(updated_at DESC, id DESC);
CREATE INDEX turns_page ON turns(conversation_id, ordinal DESC);
CREATE INDEX attempts_turn ON assistant_attempts(turn_id, attempt_number DESC);
```

**DB-002.** IDs are cryptographically generated UUIDv4 strings. Times are UTC epoch milliseconds. Ordinals establish conversation order independent of clock changes. `selected_attempt_id` integrity MUST be enforced by triggers plus repository checks: it may be null or identify an attempt belonging to that same turn. On deleting a selected attempt, clear the selection in the same transaction. The conversation delete path removes everything by cascade and clears its draft.

**DB-003.** Preferences defaults: app language from device if ha/fr/en else en; response language auto; theme system; metered downloads false. Draft keys are conversation IDs or `new-chat`. Save drafts 300 ms after changes and on lifecycle transitions. New-conversation drafts migrate to the created conversation transactionally.

**DB-004.** Query conversations in keyset pages of 30 using updated_at/id; query turns in pages of 30 using ordinal. Do not render all attempts or all chat history. Search uses local SQLite FTS5 with unicode61 indexing of titles, user text and terminal selected assistant text; do not index each streamed token. Keep content and FTS index updates transactionally consistent.

**DB-005.** Search starts after two characters, debounced 250 ms, returns at most 50 results/page, and opens the matching turn. Escape/compile user text into a literal FTS query; never interpolate raw SQL/FTS syntax. Preserve Hausa letters and accents in stored/displayed content. Require fixtures for case-insensitive matching and apostrophes.

**DB-006.** Migrations are numbered, checksum-locked and transactional. Before migration perform a consistent SQLite backup into app-private space. On failure restore/preserve the prior DB and enter read-only recovery with export; never delete/recreate the user's DB automatically. Do not back up a live WAL database through a naive single-file copy. Remove migration backup after successful validation and one clean restart.

## 13. Screen-by-screen requirements

### S01 — Language and introduction

Show the Namu wordmark, a short offline-assistant explanation, and Hausa / Français / English in their own names. Preselect the device locale only if supported. Continue saves preference. The next page states: setup needs a download; answers run on the device; the AI can make mistakes. Provide local Privacy and About the AI links. No account screen.

### S02 — Device and download

Run DEV-001–003 checks. Show the human-readable package size from the signed exact bytes, available storage and required additional storage. Buttons are Download, Use mobile data when relevant, and Back. Unqualified devices show the reason and Help; they cannot start the transfer. A user who declines setup can still access settings/help and any existing history.

### S03 — Setup progress

Show one progress surface with stage, bytes, percentage and Pause/Resume. Verification uses actual bytes hashed, with its own percentage. Self-test shows Preparing Namu without a fake percentage. Cancel opens a dialog stating that downloaded setup data will be removed. Completed download waiting for foreground self-test says Open Namu to finish setup. Setup state survives app restart.

### S04 — Chat

Header: Namu, quiet On this device label, new-chat control. Empty state: How can I help? plus Explain something / Translate text / Summarize text. Tapping a suggestion inserts an editable localized prompt in the composer; it does not send automatically. Composer grows from one to six lines, then scrolls. Send disabled only when empty, invalid, blocked or stopping. During generation show a labeled Stop control. A draft typed during generation is retained but cannot be submitted until the active generation ends.

Show user text in a subtle surface bubble and assistant text as a readable full-width response. Responses support paragraphs, bold, italic, lists, blockquotes, code and safe links. Unsupported Markdown degrades to text. Render plain streaming text while generating; parse bounded Markdown at completion. Tables use horizontal scrolling if rendered; never shrink body text to fit. Limit Markdown nesting to 12 and rendered source to 64 KiB/message, with plain-text fallback for larger content.

Auto-scroll only when the viewport is within 80 logical pixels of the bottom. Otherwise show Jump to latest. Do not steal focus when tokens arrive. Each answer has Copy, and the latest turn has Try again plus access to prior attempts. Links require tap and an Open link confirmation showing the hostname; allow https/http external navigation only, no custom schemes or automatic link preview.

### S05 — Conversations

List newest first, with title, last update and short plain-text preview. Search field is local. Overflow menu exposes Rename, Export conversation and Delete. Rename length is 1–80 grapheme clusters. Delete opens a confirmation and performs transactional deletion. Do not delete the active generating conversation until stop is acknowledged. Empty state links to New chat.

### S06 — Settings

Sections: Language, Appearance, Offline storage, Privacy and data, Help, About. No performance tuning controls. Appearance is System / Light / Dark. Response-language default affects new conversations; existing conversations retain their setting. Chat exposes a response-language menu without model terminology.

### S07 — Offline storage

Show installed package size/version, chats size, Ready/Needs setup/Needs repair, and any update. Actions: Check for updates, Download update, Repair, Remove offline AI, Restore previous version when eligible. Removal warns that chats remain but new answers require another download; cancel transfers and unload before file deletion. Do not delete chats to create model space.

### S08 — Privacy and data

Show no-chat-upload statement, backup policy and explicit export consequences. Actions: Export all conversations, Delete all conversations, Delete all Namu data. No telemetry toggle because v1 performs no automatic application telemetry upload. Diagnostic export is in Help and previews its content.

### S09 — Help / recovery

Bundle offline help for download interruption, low storage, slow answers, heat, missing model, export and uninstall. Show sanitized error code with Copy diagnostic details. Support contact is the configured Namu support address only after ownership is verified in release setup; do not invent an email. Opening an email client is user initiated and does not attach chats automatically.

### S10 — About the AI

Show Tiny Aya Global, Cohere Labs, Q4_K_M, upstream model link, applicable notices, model/app versions, language limitations and that it does not browse. Include bundled license text and modification/quantization attribution. External links are optional user actions; all required notices are readable offline.

**UX-001.** Bottom tabs are Chat, Conversations and Settings. Reopen last viewed conversation after launch, without auto-loading the model. If it was deleted, show empty Chat. Setup and blocking recovery screens sit above the tabs; history/help remain reachable when model use is blocked.

## 14. Namu visual system

The following values are the fixed v1 product theme. They are a new implementation specification, not a claim that an existing Namu brand manual already contains them. Use the existing approved Namu logo assets; do not redraw the logo. Asset handoff is a release prerequisite.

| Token | Light | Dark |
|---|---|---|
| Background | #FAF9F6 | #151715 |
| Surface | #FFFFFF | #202420 |
| Surface alternate | #F0F0EA | #2A302A |
| Primary text | #202620 | #F2F4EE |
| Secondary text | #555F55 | #BCC7B9 |
| Brand/action | #365C42 | #B7D5AA |
| On action | #FFFFFF | #192B1C |
| Outline | #758173 | #81907E |
| Error | #A52222 | #FFB4AB |
| Focus | #365C42 | #B7D5AA |

**DS-001.** Use DM Sans regular/medium/semibold bundled locally, plus system fallback. Body 16/24, label 14/20, title 22/28, large title 28/36. Values are logical font size/line-height. Enable system text scaling, including 200% test coverage. Obtain font files and OFL notice from the official Google Fonts DM Sans source; bundle license. [D22]

**DS-002.** Spacing scale is 4/8/12/16/24/32/48. Phone horizontal padding 16. Radii: controls 12, surfaces 16, dialogs 24. Buttons minimum height/touch target 48 logical pixels, icon glyph 24 with 48 touch area. Text links need adequate touch spacing. Do not set fixed heights on text-bearing cards.

**DS-003.** Use one consistent Material Symbols Rounded icon set with bundled assets and licensing. Pair destructive and unfamiliar controls with text. Do not use Google logos, four-color identity, Product Sans or an implication of Google affiliation.

**DS-004.** Motion: 180 ms standard state transitions, no looping decorative animations, reduced-motion setting honored. Haptics only on explicit actions and terminal success/error, never every token. Light/dark screens MUST pass text contrast 4.5:1 and control/focus contrast 3:1 using automated checks; adjust only via a reviewed token revision if a pair fails.

**DS-005.** Build NamuButton, NamuTextField, NamuDialog, StatusNotice, DownloadProgress, ChatMessage, EmptyState and StorageRow. Each MUST have disabled, pressed, loading, focused and error behavior where relevant. Use semantic roles, accessible names and text status; color alone is insufficient. Focus returns to the initiating control when dialogs close.

## 15. Localization and accessibility

**LOC-001.** Every UI string lives in keyed locale files. No string concatenation for translated sentences; use interpolation/plurals. Localize dates and byte formatting. Locale files have identical keys and placeholders. English fallback is allowed during development but release requires all keys translated and reviewed.

**LOC-002.** Native Hausa reviewers MUST review Hausa onboarding, privacy, errors and starter prompts. French receives fluent review. Do not use Aya to generate its own production warning text. Store Hausa characters accurately; do not normalize away letters such as ƙ, ɗ and ɓ.

**A11Y-001.** Test TalkBack and VoiceOver for setup, progress, send, stop, retry, deletion and export. Announce Answering once and completion/interruption once. Do not announce every token. Download progress announcements occur at 10% milestones or a stage change, not every network event.

**A11Y-002.** Keyboard focus survives errors and rotation. Send via explicit button; mobile Return inserts newline. Hardware Ctrl/Cmd+Enter sends. Respect IME composition and never send an unfinished composition. Test mixed-direction text; per-message direction derives from content. V1 UI languages are LTR but layouts use start/end rules for future compatibility.

## 16. Privacy, exports and deletion

**SEC-001.** Store chats in app-private OS-protected files and exclude chats, journal, weights, backups and exports from automatic cloud/device-transfer backup where platform controls allow. Configure both Android backup rule generations and verify OEM behavior on the release matrix. iOS uses backup exclusions and complete file protection for chat data. Transfer staging uses protection compatible with background download after first unlock. [D12, D13]

**SEC-002.** V1 has no custom database encryption or app-lock feature. Rely on sandbox and OS file protection; do not advertise resistance to a rooted/unlocked compromised device. No prompts, responses, titles or clipboard contents in diagnostic logs, crash breadcrumbs, analytics or CI artifacts from real users.

**SEC-003.** Network code is permitted only for explicit model metadata/download operations and user-opened external links. Disable Markdown images, remote fonts, automatic previews, analytics SDKs and cloud fallback. Use OS TLS validation and signed descriptors; do not implement fragile leaf-certificate pinning.

**SEC-004.** Single-conversation export is UTF-8 `.txt`, containing title, timestamps, language, selected answers and interrupted labels. All-conversation export is a ZIP of these text files plus `index.json` with export schema version 1. No import in v1. Native export code streams from a consistent DB snapshot; do not assemble the full history in JS memory. Present a share/save sheet only after completion. Exports explicitly warn that files may leave app protection.

**SEC-005.** Delete temporary export files after share completion when possible and sweep leftovers older than 24 hours on startup. Interrupted exports leave source data unchanged. Do not auto-send support email or queue personal content for later transmission.

**SEC-006.** Delete all conversations requires a confirmation naming the scope, cancels generation, clears conversations/attempts/drafts/search index, and preserves model/settings. Delete all Namu data requires a separate confirmation, cancels transfers, awaits inference shutdown, removes DB/journal/models/exports/preferences, then returns to S01. If shutdown cannot be confirmed, defer deletion and ask the user to reopen; never delete mmap files being used by a running engine.

**SEC-007.** Do not promise forensic secure erasure. Checkpoint/truncate SQLite WAL after user deletion when safe; deletion semantics are application-level. Hide chat content in the app-switcher preview on both platforms. Clipboard copying occurs only after user action.

## 17. Product error contract

Every recoverable error has a stable code, localized explanation, retained state and primary recovery action. Error UI never exposes stack traces or filesystem paths.

| Code | User meaning | Required behavior |
|---|---|---|
| DEVICE_INELIGIBLE | This version cannot run on this phone | Block model download; preserve access to help/history |
| SPACE_LOW | More storage is needed | Pause; show additional required bytes; preserve current model |
| NETWORK_WAIT | Waiting for a connection | Keep progress; resume under consented network policy |
| TRANSFER_RETRY | Download could not continue | Retain valid partial data; Retry action |
| TRANSFER_RESTART | Download must restart | Explain new zero progress; do not claim bytes resumed |
| SIGNATURE_INVALID | Update could not be verified | Reject metadata; keep active model |
| FILE_DAMAGED | Download needs repair | Remove corrupt staging only; explicit retry |
| MODEL_INCOMPATIBLE | Update needs another app version | Reject activation; keep current model |
| MODEL_LOAD_FAILED | Offline AI could not start | Unload safely; repair flow; no auto-reload loop |
| MEMORY_LOW | Not enough available memory | Stop/checkpoint/unload; Retry after other apps close |
| DEVICE_HOT | Phone needs to cool down | Stop/checkpoint; enforce thermal recovery rule |
| INPUT_TOO_LONG | Message is too long | Keep draft; show instruction to shorten |
| ANSWER_INTERRUPTED | Answer stopped before completion | Preserve partial; Try again |
| STORAGE_WRITE_FAILED | Answer could not be saved | Stop inference; keep visible unsaved text for Copy; do not label saved |
| DATABASE_RECOVERY | Saved chats need recovery | Read-only/export where possible; never silently wipe |
| CANCEL_TIMEOUT | Answer could not be stopped safely | Disable new inference; require app reopen |

**ERR-001.** At startup, a persisted native-load crash marker causes safe mode: do not auto-load; allow history, export and repair. A crash does not trigger repeated destructive model redownloads. Differentiate native OOM/process kill from caught allocation errors in diagnostics without claiming exact cause when unavailable.

## 18. Nonfunctional requirements and instrumentation

These are hard release acceptance targets on the qualified device matrix, measured in release builds. They are not promises about untested devices.

| ID | Requirement | Measurement |
|---|---|---|
| NFR-001 | Interactive shell P95 ≤2 s cold; saved history visible P95 ≤500 ms after DB open | 20 launches/device; model unloaded; 10,000-message fixture |
| NFR-002 | Warm first token P95 ≤6 s for a 128-token formatted prompt | Model loaded; 30 runs/language/device; disclose all timing boundaries |
| NFR-003 | Cold model load P95 ≤12 s | 20 loads/device, including cold filesystem-cache runs where reproducible |
| NFR-004 | Median decode ≥5 tokens/s; P10 ≥3 tokens/s | 128 generated tokens, fixture prompts; no cherry-picked run |
| NFR-005 | Stop UI acknowledgement ≤100 ms; native stop P95 ≤1 s | During both prefill and decode |
| NFR-006 | No freeze >200 ms caused by model work or database calls | Trace typing/scrolling during generation; P95 frame time ≤32 ms at 60 Hz test setting |
| NFR-007 | No crash/OOM/ANR in 100 consecutive standard turns/device | Include cancellation, navigation and background interruptions |
| NFR-008 | No continuing memory growth across 50 load/generate/stop/unload cycles | Compare settled native/process memory, not just JS heap |
| NFR-009 | Sustained final-minute throughput ≥70% of first-minute throughput | 15-minute fixed workload, ambient 22–25°C, case removed, unplugged |
| NFR-010 | History/search scales to 1,000 conversations / 10,000 messages | Search P95 ≤500 ms and paginated open P95 ≤500 ms |
| NFR-011 | Repeated background/process kill does not lose completed answers | Check DB after each interruption injection |
| NFR-012 | Zero app-originated network requests during local chat journey | Model installed; metadata checks disabled unless user requests them |

**OBS-001.** Store a bounded local diagnostic ring: maximum 5 MiB, seven days, whichever comes first. Fields: timestamp, event code, app/runtime/model versions, coarse device information, context/input/output token counts, timings, peak memory, thermal state, transfer error/retry counts and byte progress. Never store text, message IDs in shared reports, account identifiers, headers or local paths. V1 has no automatic diagnostic upload.

**OBS-002.** Add spans for load, template formatting, tokenize, prefill, first token, decode, stop, unload, DB commit, transfer, verify and activation. Use Android Perfetto and iOS Instruments/signposts. Capture prompt/decode kernel metrics with llama-bench separately; it is not the app's end-to-end latency result. [D16, D17]

**OBS-003.** Benchmark result identity MUST include device model/OS, available memory, runtime build ID, artifact digest, app build, thread/context/batch parameters, charging state, thermal state, sample count and test fixture hash. No performance claims from simulator results or debug JS execution.

**OBS-004.** A device that fails release targets is excluded from the qualified list; engineers MUST NOT silently lower targets, enable cloud fallback or substitute another model. Fix performance, restrict distribution appropriately or revise the PRD through a tracked change. Compatibility policy is part of the release evidence.

## 19. Physical device qualification

Required physical test inventory:

| Platform | Device class | Purpose |
|---|---|---|
| Android | 6 GB Samsung midrange device with arm64 CPU | Minimum target class |
| Android | 6 GB Tecno/Infinix device with MediaTek SoC | Deployment-relevant OEM and CPU variation |
| Android | 8 GB Redmi/Xiaomi device with Snapdragon SoC | Second OEM, storage and scheduler behavior |
| Android | Current Pixel reference device | Current Android, profiling and compatibility |
| iOS | iPhone 13 Pro, 6 GB | Older Metal/6 GB qualification |
| iOS | iPhone 15 Pro, 8 GB | Higher-memory reference |

**QA-001.** Record exact model numbers, SoCs and installed OS versions in `benchmarks/devices.json`; a category name is not a benchmark result. Cover Android 10 minimum API through current target API in functional testing and iOS 17 plus current supported iOS. Where one phone cannot run a minimum OS, use another eligible physical device for inference and emulators for UI/API coverage. These are required test roles, not a shopping recommendation.

**QA-002.** Execute fixed short, 512-token and near-budget prompts; 20-turn chats; mixed-language and emoji input; 15-minute sustained sessions; incoming interruption; low storage; battery saver; 50 load/unload cycles; 24-hour paused transfer; restart while installing. Run one warm-up and at least ten short samples/profile; use 30 for first-token gate.

**QA-003.** Devices with unsupported thermal APIs require measured sustained behavior and documented absence of thermal readings. Record battery drain but do not equate a percentage point across different batteries with a consistent energy quantity.

## 20. Mandatory failure and security tests

| Test ID | Injection / test | Pass condition |
|---|---|---|
| T01 | Clean install with network absent | Setup explains download need; no false Ready state |
| T02 | Fully installed, airplane mode, cold launch | All local features work; no startup network dependency |
| T03 | Drop connection at 10%, 50%, 99% | Correct resume or explicit iOS restart; valid bytes never blindly concatenated |
| T04 | Server returns 200 to Range | Staging restarts; length/hash remain correct |
| T05 | Wrong Content-Range / changed ETag / truncated body | Reject/restart safely; no activation |
| T06 | 416 with complete versus incomplete local bytes | Verify complete file; restart incomplete file |
| T07 | Endless or oversized body | Abort at signed size bound; preserve reserve/current model |
| T08 | Invalid signature/hash/schema/sequence | Reject; no native parser invocation on untrusted file |
| T09 | Fill storage during transfer/hash/activation | Clear error; old artifact and chat DB remain valid |
| T10 | Kill at each activation checkpoint | Exactly one valid active pointer; recovery is deterministic |
| T11 | Update while answering | Stage update only; activation waits for explicit idle transition |
| T12 | iOS force-quit during background download | Relaunch reconciles tasks; never promises impossible auto-resume |
| T13 | Native load crash / invalid memory allocation | Safe startup; no crash/reload loop |
| T14 | Rapid Send twice / Stop twice / change screens | Single generation, exactly one terminal event, correct conversation |
| T15 | Cancel during prefill/decode | Timely native acknowledgement; no freed active context |
| T16 | Kill while streaming | User message preserved; partial checkpoint marked interrupted |
| T17 | Switch conversations with secret sentinel in old context | No sentinel leakage into new prompt/runtime session |
| T18 | Retry latest answer then send next turn | Exactly one selected attempt enters context |
| T19 | Huge paste / template budget overflow | Draft retained; no silent input truncation |
| T20 | HTML, images, javascript links, deeply nested Markdown | Safe bounded rendering; zero automatic external requests |
| T21 | Migrate each prior supported DB version; inject failure | Preserve old DB or readable export; never reset silently |
| T22 | Delete chat/all data/model during activity | Required stop completes before deletion; scope is exact |
| T23 | Export cancelled/low space/share failure | Source DB intact; temporary export removed later |
| T24 | TalkBack/VoiceOver + 200% text | Setup, chat, stop and destructive controls fully usable |
| T25 | Locale key/plural/placeholder checks | No missing/replaced placeholders in en/fr/ha |
| T26 | Proxy/network inspection | No prompt/history/model execution traffic |
| T27 | OS backup/restore and app-switcher capture | Actual behavior matches privacy statement |
| T28 | Native library/16 KB packaging validation | Release native artifacts align and load correctly |
| T29 | Same descriptor sequence with altered payload; expired metadata | Reject metadata; existing model still works |
| T30 | Key rotation via app upgrade | Old valid installation works; new release key accepted only as bundled |

**QA-004.** Unit-test domain state transitions, context selection, schema constraints and descriptor parsing. Use fake inference/transfer adapters in UI tests; run actual-model contract tests separately. Native tests MUST cover background callbacks without a JS process. Test generated output semantically and structurally, not with brittle exact-text snapshots across hardware.

## 21. Language quality and model qualification

**EVAL-001.** Build a versioned, consent-free evaluation set of 300 prompts: 100 Hausa, 100 French, 100 English. In each language include 25 explanations, 20 translations, 15 summaries, 15 multi-turn instructions, 15 uncertainty/factual-limit cases and 10 safety cases. Add 30 separate mixed-language prompts. Do not use real private chat logs.

**EVAL-002.** Two fluent reviewers per language independently score comprehension, language correctness and usefulness on 1–5 scales. Release requires median ≥4 on each dimension/language, ≥90% requested-language adherence, and no unresolved critical safety failure in this set. Resolve reviewer disagreements greater than one point through review. Passing the set is evidence for this evaluation, not proof that the model is always safe or correct.

**EVAL-003.** Compare quantized mobile outputs with the same official artifact on a reference runtime and verify template/stop parity. Model card limitations remain visible. Do not market untested Zarma, Fulfulde or Tamasheq support.

**EVAL-004.** Record artifact digest, prompt version and runtime build for every evaluation report. Any change to those values requires prompt/quality regression tests and representative-device performance tests before release.

## 22. CI, release and maintenance policy

**REL-001.** Every PR MUST pass TypeScript strict checks, lint, locale checks, domain/database tests, Android build and iOS build. Runtime/transfer changes also require native contract tests. Use a small redistributable fixture model for fast native smoke tests, but qualify actual Aya before release; test fixtures never become a user-visible second model.

**REL-002.** Lock npm, CocoaPods and Gradle dependencies; generate SBOM and third-party notices; scan dependencies and native code. Retain unstripped Android symbols/dSYMs and artifact checksums. A runtime change MUST NOT be merged as an unreviewed automatic dependency bump.

**REL-003.** Release build record includes app commit, toolchain lock, package lock hashes, runtime/native patch hashes, model lock, signed-descriptor digest, prompt version, schema version, test results, language-review results and supported-device evidence. Build from a clean checkout using npm ci.

**REL-004.** Store distribution is Android App Bundle through Play and iOS archive through App Store Connect. Explain in review notes that downloadable GGUF is model data interpreted by the bundled runtime; do not add remotely downloaded executable plugins. Provide a reviewer setup path and accurate offline/download disclosures. Confirm current target SDK/Xcode/store requirements at release time; submission rules change independently of this PRD.

**REL-005.** Roll out to internal testing, then a consented 20-user pilot, then staged public release. Pilot participation requires completed applicable model-use authorization. Pass all required journeys on both platforms before public expansion. V1 does not add analytics solely to measure pilot usage; gather structured user feedback and explicit diagnostic exports.

**REL-006.** App rollout rollback and model rollback are separate. Stop promoting a failing app build; do not down-migrate a newer DB using an older executable without a tested supported path. Publish a higher-sequence known-good model descriptor for online recovery; offline devices keep their verified local release. No remote kill switch disables offline chat.

**REL-007.** Critical security fixes receive an expedited tested app/model release. An offline device cannot receive immediate revocation; document this operational limit. Signing-key compromise is handled through app-store key replacement and a new trusted descriptor, not by accepting keys supplied by the compromised endpoint.

## 23. Required implementation sequence and completion evidence

Execute these milestones in order. Each ends with a reviewable artifact and passing gate; do not mark a milestone complete from code presence alone.

| Milestone | Exact work | Completion evidence |
|---|---|---|
| M0 — Foundation and rights | Register app IDs; confirm model-use scope; initialize fixed stack; lock dependencies/toolchain; import approved logo/DM Sans; scaffold native service contracts | Rights record, clean Android/iOS builds, toolchain lock, asset/license inventory |
| M1 — Artifact and runtime | Implement MDL acquisition; commit model lock; integrate llama.rn; apply fixed configuration; template/count/stop/reset tests; local self-test on both platforms | Exact bytes/hash/revision, no-network generation on physical Android+iPhone, runtime contract report |
| M2 — Durable data | Implement schema/migrations/repositories/drafts/FTS/export snapshots and fake engine | Transaction tests, interruption recovery, 10,000-message fixture metrics |
| M3 — Model delivery | Terraform S3/CloudFront; signer/descriptor; native journal; Android+iOS transfers; integrity, pointer activation and rollback | T03–T12, T29–T30 passed with fault server; signing/publication runbook |
| M4 — Chat behavior | Controller; budgeting; streamed UI; stop/retry; attempt selection; lifecycle/memory/thermal handling | T14–T19 passed on both platforms; no cross-conversation context leakage |
| M5 — Complete product UI | Implement S01–S10 using tokens/components; three locales; navigation; storage and privacy actions | Screen checklist, light/dark/large-text screenshots and locale reviewer sign-off |
| M6 — Hardening | Safe Markdown, backup exclusions, export/delete recovery, network audit, native packaging and DB migration tests | T01–T30 passed; security/backup/export evidence |
| M7 — Qualification | All physical-device workloads, NFR gates and multilingual evaluation | Benchmark dataset, supported-device list, language report, documented failed-device exclusions |
| M8 — Release | Signed reproducible builds, notices, store disclosures, reviewer instructions, internal track, pilot, staged release | Complete REL-003 record and definition-of-done checklist |

**IMP-001.** Performance or correctness failure in M1 MUST be investigated before building the rest of the product. Keep the selected architecture/model; implement the necessary fixes and re-run the gate. If a fundamental requirement is impossible on a target device, record the evidence and revise support scope explicitly rather than silently changing behavior.

**IMP-002.** Keep each milestone's evidence in `docs/releases/v1/`. Add a requirements traceability table mapping every requirement ID to implementation path and test IDs. Documentation edits, thresholds and scope changes use versioned PRD amendments.

**IMP-003.** Engineer handoff is complete only when all MUST requirements have implementation/test references, no unresolved critical/high-severity defects remain, applicable model rights are documented, both stores have review-ready artifacts, and an eligible phone can complete setup then perform the entire local journey in airplane mode.

## 24. Exact documentation map

Read the linked section for its specified task. The implementation decision is already fixed in this PRD. Links are official project/vendor documentation; moving pages MUST be checked against the pinned source version during M0/M1. Where web extraction failed for a deep API page, use the pinned package's bundled source/types, not an invented API signature.

| Ref | Documentation | Engineer must use it for |
|---|---|---|
| D01 | [Tiny Aya Global model card](https://huggingface.co/CohereLabs/tiny-aya-global) | Architecture, declared languages, limitations and model-use terms |
| D02 | [Official GGUF repository](https://huggingface.co/CohereLabs/tiny-aya-global-GGUF) and [exact Q4_K_M artifact](https://huggingface.co/CohereLabs/tiny-aya-global-GGUF/blob/main/tiny-aya-global-q4_k_m.gguf) | Select only tiny-aya-global-q4_k_m.gguf |
| D03 | [Download guide](https://huggingface.co/docs/huggingface_hub/guides/download) and [HfApi metadata](https://huggingface.co/docs/huggingface_hub/package_reference/hf_api) | hf_hub_download, revision pinning, files_metadata and upstream artifact metadata |
| D04 | [llama.rn repository](https://github.com/mybigday/llama.rn) | Native integration and installed package API/types; read tag v0.12.9 locally |
| D05 | [llama.rn 0.12.9 release](https://github.com/mybigday/llama.rn/releases/tag/v0.12.9) | Stable version pin and bundled llama.cpp revision |
| D06 | [Android UIDT](https://developer.android.com/develop/background-work/background-tasks/uidt) | API 34+ long transfer jobs, notification, stopping and API 29–33 fallback |
| D07 | [Apple background downloads](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background) and [URLSessionDownloadTask](https://developer.apple.com/documentation/foundation/urlsessiondownloadtask) | Native background session, delegates, resume data and OS lifecycle |
| D08 | [CloudFront S3 origin access](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html) | Private bucket, Origin Access Control and bucket policy |
| D09 | [CloudFront range GETs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RangeGETs.html) | Partial requests and CDN behavior; test 200/206/416 cases |
| D10 | [OP-SQLite installation/configuration](https://op-engineering.github.io/op-sqlite/docs/installation/) | Native database setup and FTS5 configuration |
| D11 | [React Navigation setup](https://reactnavigation.org/docs/getting-started/) | Native-stack/tab dependencies and activity restoration |
| D12 | [Android Auto Backup](https://developer.android.com/identity/data/autobackup) | Explicit database/file backup and device-transfer exclusions |
| D13 | [Apple backup exclusion](https://developer.apple.com/documentation/foundation/urlresourcekey/isexcludedfrombackupkey) | Exclude chats, weights, exports and migration backups |
| D14 | [Android 16 KB page support](https://developer.android.com/guide/practices/page-sizes) | Native packaging/build/runtime verification |
| D15 | [Android Thermal API](https://developer.android.com/games/optimize/adpf/thermal) | Status/headroom limits, unsupported readings and workload response |
| D16 | [Android measurement](https://developer.android.com/topic/performance/measuring-performance) and [Apple battery profiling](https://developer.apple.com/documentation/xcode/analyzing-your-app-s-battery-use) | Physical-device instrumentation |
| D17 | [llama-bench](https://github.com/ggml-org/llama.cpp/blob/master/tools/llama-bench/README.md) | Kernel/prefill/decode benchmarks separate from app timing |
| D18 | [React Native versions](https://reactnative.dev/versions) and [performance](https://reactnative.dev/docs/performance) | RN 0.86 reference, JS/native thread behavior and release profiling |
| D19 | [React Native Paper](https://github.com/callstack/react-native-paper) | Material components customized through Namu tokens |
| D20 | [Zustand](https://github.com/pmndrs/zustand) | Selective transient UI subscriptions; no duplicate durable chat store |
| D21 | [Android accessibility testing](https://developer.android.com/guide/topics/ui/accessibility/testing) and [Apple accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) | Manual screen-reader and large-text test coverage |
| D22 | [DM Sans source and license](https://github.com/google/fonts/tree/main/ofl/dmsans) | Local font assets and OFL attribution; acquire through approved developer source access |
| D23 | [Google AI Edge Gallery](https://github.com/google-ai-edge/gallery) | Product reference for clear local-model setup/status; not Namu's runtime or brand |
| D24 | [Android offline-first data](https://developer.android.com/topic/architecture/data-layer/offline-first) | Local data as the UI source of truth |

## 25. Release checklist

- [ ] Fixed stack builds from committed locks on clean CI runners.
- [ ] Exact model filename, full upstream revision, byte count and SHA-256 recorded and verified.
- [ ] Intended model use and redistribution are authorized; notices are bundled.
- [ ] One model is exposed; no hidden cloud inference or model marketplace exists.
- [ ] Native downloads survive documented interruptions and display honest restart behavior.
- [ ] Signed descriptors, bounded transfers, atomic activation and rollback pass fault injection.
- [ ] Cancellation is out-of-band, acknowledged and free of native use-after-free.
- [ ] Chat commits, drafts, retries, context budgets and cross-chat isolation pass tests.
- [ ] All S01–S10 surfaces match Namu tokens in light/dark/large text.
- [ ] Hausa/French/English strings and response quality pass human review.
- [ ] Backup, deletion, export and network behavior match the privacy wording.
- [ ] Both platforms pass their physical-device gates; supported devices are evidence-backed.
- [ ] No unresolved critical/high defects; current app-store requirements verified.
- [ ] Engineer has supplied traceability, release record and operating runbooks.

The fixed design is complete when this checklist is satisfied. Provisioned hostnames, signing keys, asset files, dependency lock outputs and model digest are concrete build inputs produced by the specified milestones; they are not fields to fill with guessed values.
