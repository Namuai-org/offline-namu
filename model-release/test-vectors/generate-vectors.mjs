#!/usr/bin/env node
// Generates descriptor-vectors.json: the shared conformance vectors for the
// Node reference verifier, the Kotlin verifier and the Swift verifier
// (T08, T29, T30). Keys here are TEST keys generated on the spot; they are not
// trusted by any build.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildPayload, rawPublicKeyB64, signPayloadBytes} from '../descriptor/sign.mjs';
import {verifyDescriptor} from '../descriptor/verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const keyA = crypto.generateKeyPairSync('ed25519').privateKey;
const keyB = crypto.generateKeyPairSync('ed25519').privateKey;
const KEY_ID = 'test-vector-key-a';

const lock = {
  repo_id: 'CohereLabs/tiny-aya-global-GGUF',
  revision: '0123456789abcdef0123456789abcdef01234567',
  filename: 'tiny-aya-global-q4_k_m.gguf',
  bytes: 2143977056,
  sha256: 'a'.repeat(64),
  architecture: 'cohere2',
  quantization: 'Q4_K_M',
};
const RUNTIME = 'llamarn-0.12.9-b10256';
const NOW = '2026-09-17T12:00:00Z';

const base = overrides =>
  buildPayload({
    lock,
    sequence: 6,
    artifactVersion: 'aya-global-q4km-1',
    runtimeBuildIds: [RUNTIME],
    minAppBuild: 1,
    maxAppBuild: 999999,
    issuedAt: '2026-09-01T00:00:00Z',
    ...overrides,
  });

const bytesOf = payload => Buffer.from(JSON.stringify(payload), 'utf8');
const sign = (payloadBytes, key = keyA, keyId = KEY_ID) =>
  Buffer.from(signPayloadBytes(payloadBytes, key, keyId), 'utf8');

const vectors = [];
const add = (name, envelope, expect, opts = {}) =>
  vectors.push({
    name,
    source: opts.source ?? 'update',
    context: opts.context ?? {},
    envelope_b64: envelope.toString('base64'),
    expect,
  });

// --- accepted -------------------------------------------------------------
add('valid-update', sign(bytesOf(base())), 'accept');
add('valid-bundled', sign(bytesOf(base({sequence: 1}))), 'accept', {source: 'bundled'});
add('expired-bundled-still-trusted',
  sign(bytesOf(base({sequence: 1, issuedAt: '2025-01-01T00:00:00Z'}))), 'accept',
  {source: 'bundled'});
add('unknown-extra-field-ignored',
  sign(bytesOf({...base(), future_field: {nested: [1, 2, 3]}})), 'accept');
{
  const payloadBytes = bytesOf(base({sequence: 5}));
  add('same-sequence-same-payload', sign(payloadBytes), 'accept', {
    context: {
      highestSequencePayloadSha256: crypto.createHash('sha256').update(payloadBytes).digest('hex'),
    },
  });
}
add('signed-rollback-to-earlier-artifact',
  sign(bytesOf(base({sequence: 9, artifactVersion: 'aya-global-q4km-0'}))), 'accept');

// --- signature / structure ------------------------------------------------
{
  const env = JSON.parse(sign(bytesOf(base())).toString('utf8'));
  const tampered = Buffer.from(env.payload_b64, 'base64');
  tampered[10] ^= 0x01;
  env.payload_b64 = tampered.toString('base64');
  add('tampered-payload', Buffer.from(JSON.stringify(env)), 'SIGNATURE_INVALID');
}
add('unknown-key-id', sign(bytesOf(base()), keyA, 'someone-else'), 'SIGNATURE_INVALID');
add('wrong-key-for-key-id', sign(bytesOf(base()), keyB, KEY_ID), 'SIGNATURE_INVALID');
{
  const env = JSON.parse(sign(bytesOf(base())).toString('utf8'));
  env.signature_b64 = Buffer.from(env.signature_b64, 'base64').subarray(0, 63).toString('base64');
  add('short-signature', Buffer.from(JSON.stringify(env)), 'SIGNATURE_INVALID');
}
{
  const json = JSON.stringify(base());
  const dup = json.replace('{"schema":1,', '{"schema":1,"sha256":"' + 'b'.repeat(64) + '",');
  add('duplicate-key-in-payload', sign(Buffer.from(dup, 'utf8')), 'SIGNATURE_INVALID');
}
{
  const env = sign(bytesOf(base())).toString('utf8');
  const dup = env.replace('{', '{"key_id": "' + KEY_ID + '",');
  add('duplicate-key-in-envelope', Buffer.from(dup, 'utf8'), 'SIGNATURE_INVALID');
}
add('unknown-schema', sign(bytesOf({...base(), schema: 2})), 'SIGNATURE_INVALID');
{
  const p = base();
  delete p.sha256;
  add('missing-required-field', sign(bytesOf(p)), 'SIGNATURE_INVALID');
}
add('bytes-not-integer', sign(Buffer.from(
  JSON.stringify(base()).replace(`"bytes":${lock.bytes}`, '"bytes":2143977056.5'))),
  'SIGNATURE_INVALID');
add('bytes-as-string', sign(bytesOf({...base(), bytes: String(lock.bytes)})), 'SIGNATURE_INVALID');
add('uppercase-sha256', sign(bytesOf({...base(), sha256: 'A'.repeat(64)})), 'SIGNATURE_INVALID');
add('trailing-data-in-payload',
  sign(Buffer.concat([bytesOf(base()), Buffer.from(' {}')])), 'SIGNATURE_INVALID');
add('invalid-utf8-in-payload',
  sign(Buffer.concat([Buffer.from('{"schema":1,"x":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')])),
  'SIGNATURE_INVALID');
add('oversized-payload',
  sign(bytesOf({...base(), padding: 'x'.repeat(33 * 1024)})), 'SIGNATURE_INVALID');
{
  const env = JSON.parse(sign(bytesOf(base())).toString('utf8'));
  env.padding = 'x'.repeat(65 * 1024);
  add('oversized-envelope', Buffer.from(JSON.stringify(env)), 'SIGNATURE_INVALID');
}
add('wrong-model-id', sign(bytesOf({...base(), model_id: 'other-model'})), 'SIGNATURE_INVALID');

// --- path -----------------------------------------------------------------
add('path-traversal', sign(bytesOf(base({path: 'models/../../etc/model.gguf'}))), 'SIGNATURE_INVALID');
add('path-other-origin', sign(bytesOf(base({path: 'https://evil.example/model.gguf'}))), 'SIGNATURE_INVALID');
add('path-with-query', sign(bytesOf(base({path: 'models/a/model.gguf?x=1'}))), 'SIGNATURE_INVALID');
add('path-leading-slash', sign(bytesOf(base({path: '/models/a/model.gguf'}))), 'SIGNATURE_INVALID');
add('path-double-slash', sign(bytesOf(base({path: 'models//model.gguf'}))), 'SIGNATURE_INVALID');

// --- sequence / time (T29) --------------------------------------------------
add('lower-sequence-replay', sign(bytesOf(base({sequence: 4}))), 'SIGNATURE_INVALID');
add('same-sequence-altered-payload',
  sign(bytesOf(base({sequence: 5, artifactVersion: 'altered'}))), 'SIGNATURE_INVALID',
  {context: {highestSequencePayloadSha256: 'c'.repeat(64)}});
add('expired-update', sign(bytesOf(base({issuedAt: '2026-01-01T00:00:00Z', validDays: 30}))),
  'SIGNATURE_INVALID');
add('issued-in-future', sign(bytesOf(base({issuedAt: '2026-12-01T00:00:00Z'}))), 'SIGNATURE_INVALID');
add('validity-longer-than-180-days',
  sign(bytesOf({...base(), expires_at: '2027-09-01T00:00:00Z'})), 'SIGNATURE_INVALID');
add('timestamp-with-offset',
  sign(bytesOf({...base(), issued_at: '2026-09-01T00:00:00+01:00'})), 'SIGNATURE_INVALID');

// --- compatibility ----------------------------------------------------------
add('incompatible-runtime', sign(bytesOf(base({runtimeBuildIds: ['llamarn-9.9.9-b1']}))), 'MODEL_INCOMPATIBLE');
add('app-build-too-old', sign(bytesOf(base({minAppBuild: 500}))), 'MODEL_INCOMPATIBLE');
add('app-build-too-new', sign(bytesOf(base({maxAppBuild: 50}))), 'MODEL_INCOMPATIBLE');
add('unknown-prompt-version', sign(bytesOf({...base(), prompt_version: 'namu-text-99'})), 'MODEL_INCOMPATIBLE');
add('unknown-license-notice', sign(bytesOf({...base(), license_notice_id: 'remote-notice'})), 'MODEL_INCOMPATIBLE');
add('wrong-architecture', sign(bytesOf({...base(), architecture: 'llama'})), 'MODEL_INCOMPATIBLE');
add('wrong-quantization', sign(bytesOf({...base(), quantization: 'Q8_0'})), 'MODEL_INCOMPATIBLE');
add('known-bad-digest', sign(bytesOf({...base(), sha256: 'd'.repeat(64),
  path: `models/aya-global-q4km/${'d'.repeat(64)}/model.gguf`})), 'FILE_DAMAGED');

const file = {
  description: 'Shared descriptor conformance vectors. Regenerate with generate-vectors.mjs; keys are throwaway test keys.',
  keys: [{key_id: KEY_ID, public_key_b64: rawPublicKeyB64(keyA)}],
  context: {
    appBuild: 100,
    runtimeBuildId: RUNTIME,
    promptVersions: ['namu-text-1'],
    licenseNoticeIds: ['tiny-aya-cc-by-nc-4.0-v1'],
    now: NOW,
    highestSequence: 5,
    highestSequencePayloadSha256: null,
    knownBad: ['d'.repeat(64)],
  },
  vectors,
};

// Self-check against the reference verifier before writing.
for (const v of vectors) {
  const ctx = {...file.context, ...v.context, keys: file.keys, source: v.source,
    nowMs: Date.parse(NOW)};
  const result = verifyDescriptor(Buffer.from(v.envelope_b64, 'base64'), ctx);
  const actual = result.ok ? 'accept' : result.code;
  if (actual !== v.expect) {
    throw new Error(`${v.name}: expected ${v.expect}, reference says ${actual} (${result.reason})`);
  }
}
fs.writeFileSync(path.join(here, 'descriptor-vectors.json'), JSON.stringify(file, null, 2) + '\n');
console.log(`wrote ${vectors.length} vectors`);
