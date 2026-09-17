# Runbook: publishing a model artifact and its release descriptor

Implements PRD DST-002, DST-003, SIG-001…005, REL-006 (milestone M3). Run it
first against **staging**, end to end, then against production.

> **Execution status of this runbook.** The Node tools are covered by
> `node --test model-release/` (they run against the local fault server, AWS
> commands in `--dry-run`). The AWS CLI steps and everything against a real
> CloudFront distribution have **not** been executed by the author: no AWS
> account, no Terraform apply and no model download were available. Treat the
> first staging run as the validation of steps 2, 3 and 5.

## Invariants (do not improvise around these)

1. **Order:** artifact → verify full and range downloads through CloudFront →
   only then the descriptor. A descriptor must never point at bytes that have
   not been downloaded and hashed through the distribution.
2. **Byte identity:** the uploaded object is the file that `acquire.py`
   verified. No ZIP, gzip, re-quantization or "optimization". No
   `Content-Encoding`.
3. **An S3/CloudFront ETag is not a SHA-256** and is never compared with one.
   Integrity is the S3 `ChecksumSHA256` of a single `PutObject` plus a streamed
   SHA-256 of the download.
4. **Keys are immutable:** `models/aya-global-q4km/<sha256>/model.gguf` is
   written once (`If-None-Match: *`) and never overwritten or deleted while any
   descriptor, current or bundled in a shipped app, refers to it.
5. **Sequence only goes up.** Rollback is a *new, higher* sequence.
6. Nothing here needs, or may use, credentials inside the app. Publishing uses
   the publisher role; reading uses plain HTTPS.

## Inputs

| Input | Where it comes from |
|---|---|
| `model-release/model.lock.json` + the artifact file | `model-release/acquire.py` (MDL-003), after model-use authorization (PRD-007) |
| `BUCKET`, `ORIGIN`, `DISTRIBUTION_ID`, publisher role ARN | `terraform -chdir=infra/envs/<env> output` — never typed from memory (DST-001) |
| Signing key file, `key_id`, `release-keys.json` | `docs/runbooks/signing-keys.md`; the private key exists only in the protected release environment |
| Runtime build ID, app build range | the app release being served (`BuildConfig.RUNTIME_BUILD_ID` / `NamuRuntimeBuildId`, store build numbers) |
| Current highest published `sequence` | the release log (`docs/releases/v1/model/`), cross-checked by the tool against the live descriptor |

Tools needed on the release machine: Node ≥ 22.11, AWS CLI v2 recent enough
to support `s3api put-object --if-none-match` and `--checksum-sha256`
(check `aws s3api put-object help`), OpenSSL ≥ 3 for key generation.

```bash
# values from Terraform outputs of the environment being published to
ENV=staging
BUCKET=$(terraform -chdir=infra/envs/$ENV output -raw artifact_bucket_name)
ORIGIN=$(terraform -chdir=infra/envs/$ENV output -raw model_origin)
DISTRIBUTION_ID=$(terraform -chdir=infra/envs/$ENV output -raw distribution_id)
PUBLISHER_ROLE=$(terraform -chdir=infra/envs/$ENV output -raw publisher_role_arn)
```

Assume the publisher role for the AWS steps (any standard method: a CLI
profile with `role_arn = $PUBLISHER_ROLE`, or `aws sts assume-role`). The
tools never read or print credentials. Confirm with
`aws sts get-caller-identity` that the session is the publisher role and the
expected account before continuing.

## Step 1 — Preflight (local only)

```bash
node model-release/publish/preflight.mjs
```

Passes only if the lock is complete (full 40-hex revision, exact byte count,
64-hex SHA-256, the exact repo/file/architecture/quantization) and the local
file's size and streamed SHA-256 equal the lock. A failure here means
re-acquire; never edit the lock by hand.

## Step 2 — Upload the artifact (AWS, publisher role)

```bash
node model-release/publish/upload-artifact.mjs --bucket "$BUCKET" --dry-run   # read the commands first
node model-release/publish/upload-artifact.mjs --bucket "$BUCKET"
```

What runs:

```
aws s3api put-object --region eu-west-1 --bucket $BUCKET \
  --key models/aya-global-q4km/<sha256>/model.gguf --body <artifact> \
  --content-type application/octet-stream \
  --cache-control public,max-age=31536000,immutable \
  --checksum-algorithm SHA256 --checksum-sha256 <base64 of lock.sha256> \
  --if-none-match '*'
aws s3api head-object ... --checksum-mode ENABLED
```

* A single `PutObject` is deliberate (the artifact is below the 5 GB limit):
  S3 verifies the supplied SHA-256 against the received bytes and rejects a
  mismatch, and stores a **full-object** checksum. `aws s3 cp` would use a
  multipart upload whose SHA-256 is only a checksum of part checksums.
* If the key already exists the upload is refused (`412`); the tool then
  verifies the existing object instead of overwriting it.
* `head-object` must report the exact `ContentLength`, the same
  `ChecksumSHA256`, `application/octet-stream`, the immutable cache policy and
  **no** `ContentEncoding`. The ETag is printed for the record only.

## Step 3 — Validate through the distribution (HTTPS only, no credentials)

```bash
node model-release/publish/validate-distribution.mjs \
  --origin "$ORIGIN" --lock model-release/model.lock.json \
  --artifact model-release/artifacts/tiny-aya-global-q4_k_m.gguf \
  --full --report docs/releases/v1/model/<artifact_version>/validation-$ENV.json
```

Checks (each must pass; exit status 0):

| Check | Expectation |
|---|---|
| `HEAD` | `200`, exact `Content-Length`, `application/octet-stream`, no `Content-Encoding`, `Cache-Control: public,max-age=31536000,immutable`, `Accept-Ranges: bytes`, strong ETag |
| Range at start / middle / last byte / open-ended `bytes=P-` | `206`, `Content-Range: bytes a-b/<bytes>` exactly, exact length, same ETag, bytes equal the local artifact |
| Range beyond EOF (`bytes=<bytes>-`) | `416` with `Content-Range: bytes */<bytes>` |
| `If-Range` with the current strong ETag | `206` |
| `If-Range` with a wrong ETag | `200`, full length, no `Content-Range` (never a `206`) |
| Full `GET` (`--full`, ~2 GB) | `200`, exact length, streamed SHA-256 equals `lock.sha256`, aborted if the body exceeds the expected size |

The tool refuses any non-HTTPS origin except localhost, never follows
redirects and always sends `Accept-Encoding: identity`, as the app does.
`--full` is mandatory before a descriptor is published; step 5 refuses a
report without it. Run it from at least one network that resembles the users'
(the first request also warms nothing useful: each edge location caches
independently).

If a check fails: **stop**. Do not publish a descriptor. Fix the object
metadata or the distribution (`infra/`), re-run. A wrong object at an immutable
key is never overwritten in place: investigate, and if the bytes are wrong the
lock/artifact pair is wrong, which is a new acquisition.

## Step 4 — Sign the descriptor (protected release environment)

```bash
node model-release/descriptor/sign.mjs \
  --lock model-release/model.lock.json \
  --key-id <key_id bundled in the target app builds> \
  --private-key "$NAMU_SIGNING_KEY_FILE" \
  --sequence <highest published sequence + 1> \
  --artifact-version <immutable id, e.g. aya-global-q4km-1> \
  --runtime-build-id <runtime build id> [--runtime-build-id <another>] \
  --min-app-build <n> --max-app-build <n> \
  --issued-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --out /secure/workdir/stable.json

node model-release/publish/verify-descriptor.mjs \
  --descriptor /secure/workdir/stable.json --keys <release-keys.json shipped in the app> \
  --lock model-release/model.lock.json \
  --runtime-build-id <runtime build id> --app-build <a real build in range> \
  --highest-sequence <highest published sequence>
```

* Validity is at most 180 days (`--valid-days`, default 180). Put the
  expiry date in the team calendar: an expired remote descriptor cannot
  authorize updates (installed models keep working, SIG-004). Re-sign with a
  higher sequence before it lapses.
* `verify-descriptor.mjs` uses the production profile and refuses `dev-` keys,
  exactly like a release build. Verify once per supported runtime build ID and
  at both ends of the app-build range.
* The same signed file is what the app bundles as `initial-descriptor.json`
  for the first release. Record its SHA-256 in the build record (REL-003).

## Step 5 — Publish `releases/stable.json` (AWS, publisher role)

```bash
node model-release/publish/publish-descriptor.mjs \
  --bucket "$BUCKET" --origin "$ORIGIN" \
  --descriptor /secure/workdir/stable.json --keys <release-keys.json> \
  --lock model-release/model.lock.json \
  --validation-report docs/releases/v1/model/<artifact_version>/validation-$ENV.json \
  --runtime-build-id <runtime build id> --app-build <n> \
  --distribution-id "$DISTRIBUTION_ID" \
  [--first-release] --dry-run          # then again without --dry-run
```

The tool, in order: verifies the envelope as an app would and against the
lock; requires a passing `--full` validation report for this origin, path and
digest; reads the currently published descriptor and refuses a sequence that is
not strictly higher (identical bytes are reported as already published);
`HEAD`s the artifact again; uploads with `Content-Type: application/json` and
`Cache-Control: public,max-age=300`; optionally invalidates
`/releases/stable.json` (and only that path); then polls the origin until it
serves the new bytes and verifies them again. `--first-release` is required
exactly once, when nothing is published yet (the origin answers `403`/`404`).

Without an invalidation, clients may see the previous descriptor for up to
300 seconds. That is by design (DST-003).

## Step 6 — Record

Keep under `docs/releases/v1/model/<artifact_version>/` (no secrets):

* a copy of `model.lock.json` **as used for this release** (needed for any
  later rollback), and `requirements.lock.txt`;
* the signed envelope, its SHA-256, `key_id`, `sequence`, `issued_at`,
  `expires_at`;
* both validation reports (staging, production), the `head-object` output;
* the Terraform outputs used, operator, date, tool commit.

## Rollback (SIG-005, REL-006)

Model rollback is independent of app rollback and never deletes anything.

1. Decide the known-good artifact. Its object is still in the bucket under
   its own `<sha256>` key (keys are immutable, the bucket is versioned, the
   publisher role cannot delete).
2. Take **that release's** archived `model.lock.json` from
   `docs/releases/v1/model/<known-good version>/`.
3. Re-validate it through the distribution (step 3 with `--lock <archived
   lock>` and `--full`). An artifact that cannot be downloaded cannot be a
   rollback target.
4. Sign a **new** descriptor for the archived lock with
   `--sequence <highest ever published + 1>`, a fresh `--issued-at`, and the
   known-good `--artifact-version` (step 4). Never re-upload an old descriptor:
   apps that saw a higher sequence reject it as a replay (SIG-003).
5. Publish it (step 5) with `--distribution-id` so the edge cache is
   invalidated immediately.
6. Add the bad digest to the app's bundled `known-bad.json` in the next app
   release (the local known-bad list is what stops the bundled descriptor from
   reinstalling it, SIG-004).

Limits to state honestly in the incident notes (REL-006, REL-007): a device
that is offline keeps its verified local release; there is no remote kill
switch; devices check for updates only when the user asks (SIG-005); a device
that already activated the bad artifact recovers through its own self-test,
trial and *Restore previous version* logic (DL-013), not through this runbook.

## Troubleshooting

| Symptom | Meaning / action |
|---|---|
| `403` for the artifact through CloudFront | key not under `models/`/`releases/`, object missing (S3 answers 403 without `ListBucket`), or the bucket policy's `aws:SourceArn` is not this distribution. Check `terraform plan` shows no drift |
| `200` instead of `206` | something strips `Range`: a transforming proxy on the test network, or a behaviour with compression enabled. `compress` must be `false` |
| `Content-Encoding: gzip` | the object was uploaded with an encoding or a proxy transforms it. Re-upload is not possible at an immutable key: treat as a failed release of that digest and investigate before any descriptor exists |
| `put-object` `412 PreconditionFailed` | the key exists. Expected on a re-run; the tool verifies the stored object |
| `put-object` checksum error (`BadDigest`/`XAmzContentChecksumMismatch`) | the file on disk is not the locked artifact. Re-run preflight |
| Descriptor still old after publishing | edge TTL (300 s) or no invalidation. Re-run step 5; it reports "already serves exactly this descriptor" once live |
| `sequence … is not higher` | someone published in between, or the release log is stale. Never lower or reuse a sequence |
