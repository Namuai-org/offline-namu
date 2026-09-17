// node:test suite for the reference descriptor verifier and signer
// (PRD section 7; T08, T29, T30).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {buildPayload, rawPublicKeyB64, signPayloadBytes} from './sign.mjs';
import {MAX_ENVELOPE_BYTES, MAX_PAYLOAD_BYTES, verifyDescriptor} from './verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const vectorFile = JSON.parse(
  fs.readFileSync(path.join(here, '../test-vectors/descriptor-vectors.json'), 'utf8'));

const RUNTIME = 'llamarn-0.12.9-b10256';
const lock = {
  schema: 1,
  repo_id: 'CohereLabs/tiny-aya-global-GGUF',
  revision: 'f'.repeat(40),
  filename: 'tiny-aya-global-q4_k_m.gguf',
  bytes: 123456789,
  sha256: 'e'.repeat(64),
  architecture: 'cohere2',
  quantization: 'Q4_K_M',
};

function context(keys, overrides = {}) {
  return {
    keys, source: 'update', appBuild: 10, runtimeBuildId: RUNTIME,
    promptVersions: ['namu-text-1'], licenseNoticeIds: ['tiny-aya-cc-by-nc-4.0-v1'],
    nowMs: Date.parse('2026-09-17T12:00:00Z'), highestSequence: 0,
    highestSequencePayloadSha256: null, knownBad: [], ...overrides,
  };
}

function signed(privateKey, keyId, overrides = {}) {
  const payload = buildPayload({
    lock, sequence: 3, artifactVersion: 'aya-global-q4km-test', runtimeBuildIds: [RUNTIME],
    minAppBuild: 1, maxAppBuild: 100, issuedAt: '2026-09-01T00:00:00Z', ...overrides,
  });
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return {payload, payloadBytes, envelope: Buffer.from(signPayloadBytes(payloadBytes, privateKey, keyId))};
}

// ---------------------------------------------------------------- shared vectors

test('vector file is well formed and covers accept and every rejection code', () => {
  assert.ok(vectorFile.vectors.length >= 30);
  const names = vectorFile.vectors.map(v => v.name);
  assert.equal(new Set(names).size, names.length, 'vector names are unique');
  const outcomes = new Set(vectorFile.vectors.map(v => v.expect));
  for (const outcome of ['accept', 'SIGNATURE_INVALID', 'MODEL_INCOMPATIBLE', 'FILE_DAMAGED']) {
    assert.ok(outcomes.has(outcome), `no vector expects ${outcome}`);
  }
});

for (const vector of vectorFile.vectors) {
  test(`vector: ${vector.name} -> ${vector.expect}`, () => {
    const ctx = {
      ...vectorFile.context, ...vector.context,
      keys: vectorFile.keys, source: vector.source, nowMs: Date.parse(vectorFile.context.now),
    };
    const result = verifyDescriptor(Buffer.from(vector.envelope_b64, 'base64'), ctx);
    assert.equal(result.ok ? 'accept' : result.code, vector.expect, result.reason);
    if (result.ok) {
      assert.match(result.payloadSha256, /^[0-9a-f]{64}$/);
      assert.equal(result.descriptor.model_id, 'namu-aya-global');
    } else {
      assert.equal(result.descriptor, undefined, 'a rejected descriptor exposes no fields');
    }
  });
}

// ---------------------------------------------------------------- sign -> verify

test('sign -> verify round trip with a throwaway key', () => {
  const {privateKey} = crypto.generateKeyPairSync('ed25519');
  const keys = [{key_id: 'throwaway', public_key_b64: rawPublicKeyB64(privateKey)}];
  const {payload, payloadBytes, envelope} = signed(privateKey, 'throwaway');

  const result = verifyDescriptor(envelope, context(keys));
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.descriptor, payload);
  assert.equal(result.payloadSha256, crypto.createHash('sha256').update(payloadBytes).digest('hex'));
  assert.equal(payload.path, `models/aya-global-q4km/${lock.sha256}/model.gguf`);
  assert.equal(payload.expires_at, '2027-02-28T00:00:00Z'); // 180 days after issue
  assert.equal(Buffer.from(keys[0].public_key_b64, 'base64').length, 32);

  // The signature covers the exact payload bytes: the envelope's own JSON
  // formatting is free, the payload is not.
  const parsed = JSON.parse(envelope.toString('utf8'));
  const reformatted = Buffer.from(JSON.stringify(parsed));
  assert.equal(verifyDescriptor(reformatted, context(keys)).ok, true);
  const respaced = Buffer.from(JSON.stringify(payload, null, 1), 'utf8').toString('base64');
  const tampered = Buffer.from(JSON.stringify({...parsed, payload_b64: respaced}));
  assert.equal(verifyDescriptor(tampered, context(keys)).code, 'SIGNATURE_INVALID');

  // String input is accepted as UTF-8 text too.
  assert.equal(verifyDescriptor(envelope.toString('utf8'), context(keys)).ok, true);
});

test('T30 key rotation: only bundled keys are trusted', () => {
  const oldKey = crypto.generateKeyPairSync('ed25519').privateKey;
  const newKey = crypto.generateKeyPairSync('ed25519').privateKey;
  const oldKeys = [{key_id: 'release-old', public_key_b64: rawPublicKeyB64(oldKey)}];
  const bothKeys = [...oldKeys, {key_id: 'release-new', public_key_b64: rawPublicKeyB64(newKey)}];
  const byNew = signed(newKey, 'release-new').envelope;
  const byOld = signed(oldKey, 'release-old').envelope;

  // An app that does not bundle the new key rejects it, whatever the endpoint serves.
  assert.equal(verifyDescriptor(byNew, context(oldKeys)).code, 'SIGNATURE_INVALID');
  // The updated app accepts both during the transition.
  assert.equal(verifyDescriptor(byNew, context(bothKeys)).ok, true);
  assert.equal(verifyDescriptor(byOld, context(bothKeys)).ok, true);
  // A new key cannot borrow the old key's id.
  assert.equal(verifyDescriptor(signed(newKey, 'release-old').envelope, context(oldKeys)).code, 'SIGNATURE_INVALID');
});

test('SIG-005 signed rollback: higher sequence may point at an earlier artifact; replays may not', () => {
  const {privateKey} = crypto.generateKeyPairSync('ed25519');
  const keys = [{key_id: 'k', public_key_b64: rawPublicKeyB64(privateKey)}];
  const rollback = signed(privateKey, 'k', {sequence: 8, artifactVersion: 'aya-global-q4km-previous'});
  assert.equal(verifyDescriptor(rollback.envelope, context(keys, {highestSequence: 7})).ok, true);
  const replay = signed(privateKey, 'k', {sequence: 6});
  assert.equal(verifyDescriptor(replay.envelope, context(keys, {highestSequence: 7})).code, 'SIGNATURE_INVALID');
  // The bundled descriptor neither consults nor advances the stored sequence.
  assert.equal(verifyDescriptor(replay.envelope, context(keys, {highestSequence: 7, source: 'bundled'})).ok, true);
});

test('size limits are enforced before any parsing', () => {
  const {privateKey} = crypto.generateKeyPairSync('ed25519');
  const keys = [{key_id: 'k', public_key_b64: rawPublicKeyB64(privateKey)}];
  assert.equal(verifyDescriptor(Buffer.alloc(0), context(keys)).reason, 'envelope size');
  assert.equal(verifyDescriptor(Buffer.alloc(MAX_ENVELOPE_BYTES + 1, 0x20), context(keys)).reason, 'envelope size');
  const bigPayload = Buffer.from(JSON.stringify({pad: 'x'.repeat(MAX_PAYLOAD_BYTES)}));
  const env = Buffer.from(signPayloadBytes(bigPayload, privateKey, 'k'));
  assert.ok(env.length <= MAX_ENVELOPE_BYTES);
  assert.equal(verifyDescriptor(env, context(keys)).reason, 'payload size');
});

test('buildPayload refuses invalid validity windows and timestamps', () => {
  const args = {lock, sequence: 1, artifactVersion: 'v', runtimeBuildIds: [RUNTIME], minAppBuild: 1, maxAppBuild: 2};
  assert.throws(() => buildPayload({...args, issuedAt: '2026-09-01T00:00:00Z', validDays: 181}), /validity/);
  assert.throws(() => buildPayload({...args, issuedAt: '2026-09-01T00:00:00Z', validDays: 0}), /validity/);
  assert.throws(() => buildPayload({...args, issuedAt: '2026-09-01T00:00:00+01:00'}), /RFC 3339 UTC/);
  assert.throws(() => buildPayload({...args, issuedAt: 'yesterday'}), /RFC 3339 UTC/);
});

// ---------------------------------------------------------------- sign.mjs CLI

test('sign.mjs CLI writes an envelope that verifies, and refuses an incomplete lock', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'namu-sign-'));
  try {
    const {privateKey} = crypto.generateKeyPairSync('ed25519');
    const keyFile = path.join(tmp, 'throwaway-key.pem');
    fs.writeFileSync(keyFile, privateKey.export({format: 'pem', type: 'pkcs8'}), {mode: 0o600});
    const lockFile = path.join(tmp, 'model.lock.json');
    fs.writeFileSync(lockFile, JSON.stringify(lock));
    const out = path.join(tmp, 'stable.json');
    const args = ['--lock', lockFile, '--key-id', 'cli-throwaway', '--private-key', keyFile,
      '--sequence', '2', '--artifact-version', 'aya-global-q4km-cli', '--runtime-build-id', RUNTIME,
      '--min-app-build', '1', '--max-app-build', '50', '--issued-at', '2026-09-10T00:00:00Z', '--out', out];
    const run = spawnSync(process.execPath, [path.join(here, 'sign.mjs'), ...args], {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(`public key \\(b64\\):\\s+${rawPublicKeyB64(privateKey).replace(/[+/=]/g, '\\$&')}`));
    assert.ok(!run.stdout.includes('PRIVATE KEY'));

    const keys = [{key_id: 'cli-throwaway', public_key_b64: rawPublicKeyB64(privateKey)}];
    const result = verifyDescriptor(fs.readFileSync(out), context(keys));
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.descriptor.sequence, 2);
    assert.equal(result.descriptor.sha256, lock.sha256);
    assert.deepEqual(result.descriptor.runtime_build_ids, [RUNTIME]);

    fs.writeFileSync(lockFile, JSON.stringify({...lock, sha256: 'TBD'}));
    const refused = spawnSync(process.execPath, [path.join(here, 'sign.mjs'), ...args], {encoding: 'utf8'});
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /model lock is incomplete/);

    // An RSA key is not acceptable.
    fs.writeFileSync(lockFile, JSON.stringify(lock));
    const rsa = crypto.generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey;
    fs.writeFileSync(keyFile, rsa.export({format: 'pem', type: 'pkcs8'}));
    const wrongKey = spawnSync(process.execPath, [path.join(here, 'sign.mjs'), ...args], {encoding: 'utf8'});
    assert.notEqual(wrongKey.status, 0);
    assert.match(wrongKey.stderr, /must be Ed25519/);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});
