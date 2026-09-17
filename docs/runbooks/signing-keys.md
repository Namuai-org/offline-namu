# Runbook: release descriptor signing keys

Covers SIG-001, SIG-004, REL-007 and test T30. The signed descriptor is what
lets an app trust `{path, bytes, sha256}` fetched from the network, so the
private key is the most sensitive secret of the project: whoever holds it can
direct every app that trusts it to download and try to activate arbitrary
model data. (A bad model still has to pass the hash, the structural GGUF check
and the self-test, and the bundled runtime only interprets model data; it is
still not an acceptable outcome.)

The procedure below was exercised by the author with a throwaway key
(OpenSSL 3.6): the OpenSSL-derived public key equals the one `sign.mjs`
prints, and `verify-descriptor.mjs` accepts the resulting descriptor. No
production key has been generated; that is an owner action.

## Facts to keep straight

* Algorithm: Ed25519. Private key format: PKCS#8 PEM. Public key as bundled:
  the **raw 32 bytes**, standard base64 with padding (44 characters).
* The app trusts exactly the keys in its bundled `release-keys.json`
  (`{"keys":[{"key_id":"…","public_key_b64":"…"}]}`). There is **no remote key
  replacement** in v1: keys change only with an app-store update (SIG-004).
* A public key and the origin hostname are build configuration, not secrets.
  The private key never enters the repository, CI logs, the app, a chat
  message or a ticket. `*.pem` is git-ignored as a last line of defence, not
  as a process.
* `key_id` values starting with `dev-` are development keys; release builds
  refuse to build with them and `verify-descriptor.mjs` refuses them without
  `--dev-profile`. Never name a production key `dev-…`.
* Staging uses its **own** key and `key_id`. The production key never signs a
  fixture or a staging descriptor.

## The protected release environment

Owner decision (open item): where the production private key lives. Minimum
bar for v1:

* an offline or access-controlled machine or an HSM/KMS-class store that at
  most two named people can use; disk encryption; no cloud sync folder;
* the key file readable by its owner only (`chmod 600`), on an encrypted
  volume, with one encrypted offline backup held by a second person;
* signing happens there; only the signed `stable.json` (public) leaves;
* not a CI secret for PR workflows. If signing is ever automated, it belongs
  in a GitHub *environment* with required reviewers, never in a repository
  secret readable by ordinary workflows.

If a managed key store (HSM or a cloud KMS) is chosen instead of a key file,
first confirm that it signs with **pure Ed25519 over the exact payload bytes**
(not a pre-hashed variant): the apps verify with Tink `Ed25519Verify` and
CryptoKit `Curve25519.Signing`, and SIG-002 signs the decoded payload bytes as
they are. `sign.mjs` as written expects a PKCS#8 PEM file.

## Generate a key (release setup, once per key)

On the protected machine, with OpenSSL ≥ 3. The macOS system binary
(`/usr/bin/openssl`, LibreSSL 3.3.6 on the authoring machine) answers
`Algorithm ed25519 not found`; check `openssl version` first:

```bash
umask 077
openssl genpkey -algorithm ed25519 -out namu-release-<yyyy>-<nn>.pem

# raw 32-byte public key, base64: the last 32 bytes of the 44-byte SPKI DER
openssl pkey -in namu-release-<yyyy>-<nn>.pem -pubout -outform DER | tail -c 32 | base64

# sanity: must print 44
openssl pkey -in namu-release-<yyyy>-<nn>.pem -pubout -outform DER | wc -c
```

Choose the `key_id` (for example the file's base name). It is public and
permanent for that key; it must not start with `dev-`.

`model-release/descriptor/sign.mjs` prints the same base64 public key every
time it signs (`public key (b64): …`). The two values must match; if they do
not, stop.

## Put the public key into the app

Create the production `release-keys.json`:

```json
{"keys": [{"key_id": "<key_id>", "public_key_b64": "<44-character base64>"}]}
```

It is injected at build time together with the production
`initial-descriptor.json` and `known-bad.json` (Android
`android/app/src/main/assets/namu/`, iOS `ios/Namu/NamuConfig/`; see
`docs/engineering/native-contract.md` §1). Those paths are git-ignored because
the repository ships only development values; the release workflow must
materialize the production files from the release environment and the release
guards must pass (no `dev-` key, HTTPS origin).

Before shipping, prove the pairing on the release machine:

```bash
node model-release/publish/verify-descriptor.mjs \
  --descriptor initial-descriptor.json --keys release-keys.json \
  --source bundled --lock model-release/model.lock.json \
  --runtime-build-id <runtime build id> --app-build <this build>
```

Record in the build record (REL-003): `key_id`, the public key, the SHA-256 of
`release-keys.json` and of the signed descriptor. Never record the private key
or its passphrase.

## Rotation — only through an app update (SIG-004, T30)

Rotation is planned, not remote:

1. Generate the new key (above). New `key_id`.
2. Ship an app update whose `release-keys.json` contains **both** keys, old
   first. Its bundled `initial-descriptor.json` may be signed by either.
3. Keep signing `releases/stable.json` with the **old** key until the builds
   that only know the old key are below the support threshold — an app that
   does not bundle the new key rejects descriptors signed by it
   (`SIGNATURE_INVALID`), keeps its installed model and simply sees no update.
   `min_app_build` cannot help here: the signature is checked before the
   payload is read.
4. Switch signing to the new key with the next higher sequence. From then on
   old-key-only builds get no further model updates; their installed model and
   offline chat keep working (SIG-004, REL-006).
5. In a later app update remove the old key from `release-keys.json`. Destroy
   the old private key and its backup; log who did it and when.

What T30 must show (covered at the verifier level by
`model-release/descriptor/verify.test.mjs`; the Kotlin/Swift verifiers and an
on-device upgrade test must show the same): an installation made under the old
key keeps working after the upgrade; a descriptor signed by the new key is
accepted only by a build that bundles that key; a key served by the endpoint is
never trusted; a new key cannot reuse the old `key_id`.

There is one endpoint (`releases/stable.json`) and one signature per envelope,
so two generations of apps cannot both be served *new* descriptors during a
rotation. That is an accepted v1 limit; a dual-signed envelope would be a PRD
amendment.

## Compromise or suspected compromise (REL-007)

Treat loss of control of the key file, its backup, or the machine as
compromise. The compromised endpoint must never be the channel that supplies
new trust.

1. **Contain (minutes).** Freeze publishing: remove every principal from
   `publisher_principal_arns` except the incident lead
   (`terraform apply`), and check CloudTrail/S3 versions for unexpected writes
   to `releases/stable.json` or `models/`. An attacker needs **both** the
   signing key and write access to the bucket (or a network position against
   a client) to reach users; establish which they have.
2. **Assess.** Compare the live `releases/stable.json` with the release log
   (`docs/releases/v1/model/`). If it was replaced, restore the last legitimate
   version from S3 versioning and invalidate `/releases/stable.json`. Note:
   apps that already accepted a malicious higher sequence will reject the
   restored lower one; they are recovered by step 4, not by the endpoint.
3. **New key.** Generate a new key in a clean environment (not the suspect
   machine).
4. **Expedited app release** on both stores containing: only the new key in
   `release-keys.json` (the compromised key is removed at once, there is no
   overlap period in a compromise), a bundled descriptor signed by the new
   key, and every digest the attacker published added to `known-bad.json`.
   Follow the normal release gates for a security fix; do not skip the
   device journeys that prove setup and offline chat.
5. **Publish** a descriptor signed with the new key, sequence above anything
   ever seen, once the fixed build is available.
6. **Communicate honestly.** An offline device, or one that never opens
   *Check for updates*, cannot be told anything (REL-007). Devices on old
   builds keep trusting the compromised key until they update; the only
   mitigations for them are bucket integrity (the attacker cannot publish
   through Namu's origin without the publisher role) and TLS. There is no
   remote kill switch and offline chat keeps working.
7. **Afterwards.** Rotate the publisher credentials, review who could read the
   key, write the incident record, destroy the compromised key material.

What must never be done: accept a key delivered by the distribution endpoint,
add a "trust on first use" path, ship a build that skips signature
verification "temporarily", or reuse the compromised `key_id`.

## Loss (not compromise) of the key

If the key and its backup are lost but not exposed, nothing can be signed for
current builds any more. Installed models keep working and the bundled
descriptor still authorizes its exact digest; remote descriptors expire after
at most 180 days. Recovery is a rotation (above) starting at step 1, with the
"keep signing with the old key" step impossible: old builds stop receiving
model updates until they take the app update.
