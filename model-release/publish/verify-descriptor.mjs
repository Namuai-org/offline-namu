#!/usr/bin/env node
// Command-line front end for the reference verifier (descriptor/verify.mjs).
//
//   node model-release/publish/verify-descriptor.mjs \
//     --descriptor releases/stable.json --keys release-keys.json \
//     --runtime-build-id llamarn-0.12.9-b10256 --app-build 1 \
//     [--lock model-release/model.lock.json]   also require it to match the lock
//     [--source update|bundled] [--now 2026-09-17T00:00:00Z] \
//     [--highest-sequence 0] [--highest-sequence-payload-sha256 <hex>] \
//     [--known-bad known-bad.json] [--dev-profile]
//
// Exit status 0 only when the descriptor is accepted exactly as an app with
// the given build configuration would accept it. Local files only; no network.
import crypto from 'node:crypto';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {LICENSE_NOTICE_ID, PROMPT_VERSION} from '../descriptor/sign.mjs';
import {PRODUCTION_PROFILE, verifyDescriptor} from '../descriptor/verify.mjs';
import {descriptorLockMismatches, readLock} from './lib.mjs';

// Internal-build fixture profile (docs/engineering/native-contract.md section 4).
export const DEV_PROFILE = {
  architectures: ['cohere2', 'llama'],
  quantizations: ['Q4_K_M', 'Q8_0', 'F16', 'F32'],
};

export function loadKeys(file, {devProfile = false} = {}) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(doc.keys) || doc.keys.length === 0) {
    throw new Error(`${file} has no "keys" array`);
  }
  for (const key of doc.keys) {
    if (typeof key.key_id !== 'string' || typeof key.public_key_b64 !== 'string' ||
        Buffer.from(key.public_key_b64, 'base64').length !== 32) {
      throw new Error(`${file}: every key needs key_id and a 32-byte public_key_b64`);
    }
    if (!devProfile && key.key_id.startsWith('dev-')) {
      throw new Error(`${file}: key "${key.key_id}" is a development key; release builds refuse dev- keys`);
    }
  }
  return doc.keys;
}

/** @returns the verifyDescriptor result, plus lock mismatches when a lock is given. */
export function verifyEnvelope(envelopeBytes, {keys, source = 'update', runtimeBuildId, appBuild,
  nowMs = Date.now(), highestSequence = 0, highestSequencePayloadSha256 = null, knownBad = [],
  devProfile = false, lock = null}) {
  const result = verifyDescriptor(envelopeBytes, {
    keys, source, runtimeBuildId, appBuild, nowMs, highestSequence, highestSequencePayloadSha256, knownBad,
    promptVersions: [PROMPT_VERSION],
    licenseNoticeIds: [LICENSE_NOTICE_ID],
    profile: devProfile ? DEV_PROFILE : PRODUCTION_PROFILE,
  });
  if (result.ok && lock !== null) {
    const mismatches = descriptorLockMismatches(result.descriptor, lock);
    if (mismatches.length > 0) {
      return {ok: false, code: 'LOCK_MISMATCH', reason: mismatches.join('; ')};
    }
  }
  return result;
}

function main() {
  const {values: a} = parseArgs({
    options: {
      descriptor: {type: 'string'},
      keys: {type: 'string'},
      'runtime-build-id': {type: 'string'},
      'app-build': {type: 'string'},
      lock: {type: 'string'},
      source: {type: 'string', default: 'update'},
      now: {type: 'string'},
      'highest-sequence': {type: 'string', default: '0'},
      'highest-sequence-payload-sha256': {type: 'string'},
      'known-bad': {type: 'string'},
      'dev-profile': {type: 'boolean', default: false},
    },
  });
  for (const required of ['descriptor', 'keys', 'runtime-build-id', 'app-build']) {
    if (!a[required]) {
      throw new Error(`--${required} is required`);
    }
  }
  if (a.source !== 'update' && a.source !== 'bundled') {
    throw new Error('--source must be update or bundled');
  }
  const appBuild = Number(a['app-build']);
  const highestSequence = Number(a['highest-sequence']);
  const nowMs = a.now ? Date.parse(a.now) : Date.now();
  if (!Number.isSafeInteger(appBuild) || !Number.isSafeInteger(highestSequence) || Number.isNaN(nowMs)) {
    throw new Error('--app-build, --highest-sequence and --now must be valid');
  }
  const envelope = fs.readFileSync(a.descriptor);
  const result = verifyEnvelope(envelope, {
    keys: loadKeys(a.keys, {devProfile: a['dev-profile']}),
    source: a.source,
    runtimeBuildId: a['runtime-build-id'],
    appBuild,
    nowMs,
    highestSequence,
    highestSequencePayloadSha256: a['highest-sequence-payload-sha256'] ?? null,
    knownBad: a['known-bad'] ? JSON.parse(fs.readFileSync(a['known-bad'], 'utf8')).sha256 ?? [] : [],
    devProfile: a['dev-profile'],
    lock: a.lock ? readLock(a.lock, {allowFixture: a['dev-profile']}) : null,
  });
  if (!result.ok) {
    console.error(`REJECTED ${result.code}: ${result.reason}`);
    process.exit(1);
  }
  console.log(JSON.stringify({
    accepted: true,
    source: a.source,
    envelope_sha256: crypto.createHash('sha256').update(envelope).digest('hex'),
    payload_sha256: result.payloadSha256,
    descriptor: result.descriptor,
  }, null, 2));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`verification aborted: ${error.message}`);
    process.exit(2);
  }
}
