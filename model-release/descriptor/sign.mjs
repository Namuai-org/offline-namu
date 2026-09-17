#!/usr/bin/env node
// Release tool: build and sign a release descriptor (SIG-001, SIG-002).
//
//   node model-release/descriptor/sign.mjs \
//     --lock model-release/model.lock.json \
//     --key-id namu-release-2026-01 \
//     --private-key "$NAMU_SIGNING_KEY_FILE" \   (PKCS#8 PEM, Ed25519)
//     --sequence 1 --artifact-version aya-global-q4km-1 \
//     --runtime-build-id llamarn-0.12.9-b10256 \
//     --min-app-build 1 --max-app-build 999999 \
//     --issued-at 2026-09-17T00:00:00Z [--valid-days 180] \
//     --out releases/stable.json
//
// The private key never enters the repository or the app (SIG-001). The exact
// payload bytes written here are the bytes that are signed; nothing
// re-serializes them afterwards (SIG-002).
import crypto from 'node:crypto';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

export const RELEASE_FAMILY = 'aya-global-q4km';
export const MODEL_ID = 'namu-aya-global';
export const PROMPT_VERSION = 'namu-text-1';
export const LICENSE_NOTICE_ID = 'tiny-aya-cc-by-nc-4.0-v1';

export function buildPayload({lock, sequence, artifactVersion, runtimeBuildIds,
  minAppBuild, maxAppBuild, issuedAt, validDays = 180, path}) {
  const issued = Date.parse(issuedAt);
  if (Number.isNaN(issued) || !/Z$/.test(issuedAt)) {
    throw new Error('issued-at must be an RFC 3339 UTC timestamp');
  }
  if (validDays < 1 || validDays > 180) {
    throw new Error('validity must be between 1 and 180 days');
  }
  const expires = new Date(issued + validDays * 86400000);
  const iso = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  // Key order is fixed for reviewability only; verification never depends on it.
  return {
    schema: 1,
    sequence,
    model_id: MODEL_ID,
    artifact_version: artifactVersion,
    path: path ?? `models/${RELEASE_FAMILY}/${lock.sha256}/model.gguf`,
    bytes: lock.bytes,
    sha256: lock.sha256,
    upstream_repo: lock.repo_id,
    upstream_revision: lock.revision,
    upstream_filename: lock.filename,
    architecture: lock.architecture,
    quantization: lock.quantization,
    runtime_build_ids: runtimeBuildIds,
    min_app_build: minAppBuild,
    max_app_build: maxAppBuild,
    prompt_version: PROMPT_VERSION,
    license_notice_id: LICENSE_NOTICE_ID,
    issued_at: iso(new Date(issued)),
    expires_at: iso(expires),
  };
}

export function signPayloadBytes(payloadBytes, privateKey, keyId) {
  const signature = crypto.sign(null, payloadBytes, privateKey);
  return JSON.stringify(
    {
      key_id: keyId,
      payload_b64: payloadBytes.toString('base64'),
      signature_b64: signature.toString('base64'),
    },
    null,
    2,
  ) + '\n';
}

export function rawPublicKeyB64(privateKey) {
  const spki = crypto.createPublicKey(privateKey).export({format: 'der', type: 'spki'});
  return spki.subarray(spki.length - 32).toString('base64');
}

function main() {
  const {values: a} = parseArgs({
    options: {
      lock: {type: 'string'},
      'key-id': {type: 'string'},
      'private-key': {type: 'string'},
      sequence: {type: 'string'},
      'artifact-version': {type: 'string'},
      'runtime-build-id': {type: 'string', multiple: true},
      'min-app-build': {type: 'string'},
      'max-app-build': {type: 'string'},
      'issued-at': {type: 'string'},
      'valid-days': {type: 'string', default: '180'},
      out: {type: 'string'},
    },
  });
  for (const required of ['lock', 'key-id', 'private-key', 'sequence',
    'artifact-version', 'runtime-build-id', 'min-app-build', 'max-app-build',
    'issued-at', 'out']) {
    if (!a[required]) {
      throw new Error(`--${required} is required`);
    }
  }
  const lock = JSON.parse(fs.readFileSync(a.lock, 'utf8'));
  if (!/^[0-9a-f]{64}$/.test(lock.sha256) || !/^[0-9a-f]{40}$/.test(lock.revision) ||
      !Number.isSafeInteger(lock.bytes)) {
    throw new Error('model lock is incomplete; run acquire.py first (MDL-003)');
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(a['private-key']));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('signing key must be Ed25519');
  }
  const payload = buildPayload({
    lock,
    sequence: Number(a.sequence),
    artifactVersion: a['artifact-version'],
    runtimeBuildIds: a['runtime-build-id'],
    minAppBuild: Number(a['min-app-build']),
    maxAppBuild: Number(a['max-app-build']),
    issuedAt: a['issued-at'],
    validDays: Number(a['valid-days']),
  });
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  fs.writeFileSync(a.out, signPayloadBytes(payloadBytes, privateKey, a['key-id']));
  const digest = crypto.createHash('sha256').update(fs.readFileSync(a.out)).digest('hex');
  console.log(`descriptor written: ${a.out}`);
  console.log(`envelope sha256:    ${digest}`);
  console.log(`public key (b64):   ${rawPublicKeyB64(privateKey)}`);
}

// Compare real paths, not URL strings: a checkout path containing a space or
// a non-ASCII character is percent-encoded in import.meta.url, and the tool
// would otherwise exit 0 without signing anything.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
