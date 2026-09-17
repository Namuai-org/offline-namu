// Reference verifier for signed release descriptors (PRD section 7).
// Mirrors docs/engineering/native-contract.md §4 step by step. The Kotlin and
// Swift verifiers must agree with this implementation on every vector in
// model-release/test-vectors/descriptor-vectors.json.
import crypto from 'node:crypto';
import {
  StrictJsonError,
  getInteger,
  getString,
  getStringArray,
  parseStrictJson,
} from './strict-json.mjs';

export const MAX_ENVELOPE_BYTES = 65536;
export const MAX_PAYLOAD_BYTES = 32768;
export const MAX_VALIDITY_MS = 180 * 24 * 3600 * 1000;
export const CLOCK_SKEW_MS = 24 * 3600 * 1000;

export const PRODUCTION_PROFILE = {
  architectures: ['cohere2'],
  quantizations: ['Q4_K_M'],
};

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !B64.test(value)) {
    return null;
  }
  return Buffer.from(value, 'base64');
}

function ed25519PublicKey(raw32) {
  // SubjectPublicKeyInfo prefix for Ed25519 (RFC 8410).
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return crypto.createPublicKey({
    key: Buffer.concat([prefix, raw32]),
    format: 'der',
    type: 'spki',
  });
}

function reject(code, reason) {
  return {ok: false, code, reason};
}

function validPath(path) {
  if (!/^[A-Za-z0-9._/-]{1,512}$/.test(path)) {
    return false;
  }
  if (path.startsWith('/') || path.includes('//')) {
    return false;
  }
  return path.split('/').every(s => s !== '' && s !== '.' && s !== '..');
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * @param {Buffer|string} envelopeBytes raw downloaded/bundled envelope
 * @param {object} ctx
 *   keys: [{key_id, public_key_b64}], source: 'bundled'|'update',
 *   appBuild, runtimeBuildId, promptVersions[], licenseNoticeIds[],
 *   nowMs, highestSequence, highestSequencePayloadSha256,
 *   knownBad[], profile {architectures[], quantizations[]}
 */
export function verifyDescriptor(envelopeBytes, ctx) {
  const raw = Buffer.isBuffer(envelopeBytes)
    ? envelopeBytes
    : Buffer.from(envelopeBytes, 'utf8');
  if (raw.length === 0 || raw.length > MAX_ENVELOPE_BYTES) {
    return reject('SIGNATURE_INVALID', 'envelope size');
  }
  let envelope;
  try {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(raw);
    envelope = parseStrictJson(text);
  } catch (e) {
    return reject('SIGNATURE_INVALID', `envelope parse: ${e.message}`);
  }
  if (!(envelope instanceof Map)) {
    return reject('SIGNATURE_INVALID', 'envelope not an object');
  }
  const keyId = getString(envelope, 'key_id');
  const payload = decodeBase64(getString(envelope, 'payload_b64'));
  const signature = decodeBase64(getString(envelope, 'signature_b64'));
  if (!keyId || !payload || !signature) {
    return reject('SIGNATURE_INVALID', 'envelope fields');
  }
  if (payload.length === 0 || payload.length > MAX_PAYLOAD_BYTES) {
    return reject('SIGNATURE_INVALID', 'payload size');
  }
  if (signature.length !== 64) {
    return reject('SIGNATURE_INVALID', 'signature size');
  }
  const key = ctx.keys.find(k => k.key_id === keyId);
  if (!key) {
    return reject('SIGNATURE_INVALID', 'unknown key');
  }
  const publicRaw = decodeBase64(key.public_key_b64);
  if (!publicRaw || publicRaw.length !== 32) {
    return reject('SIGNATURE_INVALID', 'bundled key');
  }
  let verified = false;
  try {
    verified = crypto.verify(null, payload, ed25519PublicKey(publicRaw), signature);
  } catch {
    verified = false;
  }
  if (!verified) {
    return reject('SIGNATURE_INVALID', 'signature');
  }

  // Only verified bytes are parsed from here on (SIG-002).
  let p;
  try {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(payload);
    p = parseStrictJson(text);
  } catch (e) {
    const reason = e instanceof StrictJsonError ? e.message : 'utf-8';
    return reject('SIGNATURE_INVALID', `payload parse: ${reason}`);
  }
  if (!(p instanceof Map)) {
    return reject('SIGNATURE_INVALID', 'payload not an object');
  }

  const d = {
    schema: getInteger(p, 'schema'),
    sequence: getInteger(p, 'sequence'),
    model_id: getString(p, 'model_id'),
    artifact_version: getString(p, 'artifact_version'),
    path: getString(p, 'path'),
    bytes: getInteger(p, 'bytes'),
    sha256: getString(p, 'sha256'),
    upstream_repo: getString(p, 'upstream_repo'),
    upstream_revision: getString(p, 'upstream_revision'),
    upstream_filename: getString(p, 'upstream_filename'),
    architecture: getString(p, 'architecture'),
    quantization: getString(p, 'quantization'),
    runtime_build_ids: getStringArray(p, 'runtime_build_ids'),
    min_app_build: getInteger(p, 'min_app_build'),
    max_app_build: getInteger(p, 'max_app_build'),
    prompt_version: getString(p, 'prompt_version'),
    license_notice_id: getString(p, 'license_notice_id'),
    issued_at: getString(p, 'issued_at'),
    expires_at: getString(p, 'expires_at'),
  };
  for (const [field, value] of Object.entries(d)) {
    if (value === undefined) {
      return reject('SIGNATURE_INVALID', `missing or mistyped ${field}`);
    }
  }
  if (d.schema !== 1) {
    return reject('SIGNATURE_INVALID', 'unknown schema');
  }
  if (d.sequence < 1) {
    return reject('SIGNATURE_INVALID', 'sequence');
  }
  if (d.model_id !== 'namu-aya-global') {
    return reject('SIGNATURE_INVALID', 'model_id');
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(d.artifact_version)) {
    return reject('SIGNATURE_INVALID', 'artifact_version');
  }
  if (!validPath(d.path)) {
    return reject('SIGNATURE_INVALID', 'path');
  }
  if (d.bytes < 1 || d.bytes > 8_000_000_000) {
    return reject('SIGNATURE_INVALID', 'bytes');
  }
  if (!/^[0-9a-f]{64}$/.test(d.sha256)) {
    return reject('SIGNATURE_INVALID', 'sha256');
  }
  if (
    !d.upstream_repo ||
    !d.upstream_filename ||
    !/^[0-9a-f]{40}$/.test(d.upstream_revision)
  ) {
    return reject('SIGNATURE_INVALID', 'upstream fields');
  }
  const issued = parseTimestamp(d.issued_at);
  const expires = parseTimestamp(d.expires_at);
  if (issued === null || expires === null || expires <= issued) {
    return reject('SIGNATURE_INVALID', 'timestamps');
  }

  const payloadSha256 = crypto.createHash('sha256').update(payload).digest('hex');

  if (ctx.source === 'update') {
    if (expires - issued > MAX_VALIDITY_MS) {
      return reject('SIGNATURE_INVALID', 'validity too long');
    }
    if (issued > ctx.nowMs + CLOCK_SKEW_MS || ctx.nowMs >= expires) {
      return reject('SIGNATURE_INVALID', 'expired or not yet valid');
    }
    const highest = ctx.highestSequence ?? 0;
    if (d.sequence < highest) {
      return reject('SIGNATURE_INVALID', 'sequence replay');
    }
    if (
      d.sequence === highest &&
      ctx.highestSequencePayloadSha256 &&
      ctx.highestSequencePayloadSha256 !== payloadSha256
    ) {
      return reject('SIGNATURE_INVALID', 'same sequence, different payload');
    }
  }

  const profile = ctx.profile ?? PRODUCTION_PROFILE;
  if (
    !profile.architectures.includes(d.architecture) ||
    !profile.quantizations.includes(d.quantization)
  ) {
    return reject('MODEL_INCOMPATIBLE', 'architecture/quantization');
  }
  if (!d.runtime_build_ids.includes(ctx.runtimeBuildId)) {
    return reject('MODEL_INCOMPATIBLE', 'runtime build');
  }
  if (
    d.min_app_build > d.max_app_build ||
    ctx.appBuild < d.min_app_build ||
    ctx.appBuild > d.max_app_build
  ) {
    return reject('MODEL_INCOMPATIBLE', 'app build range');
  }
  if (!ctx.promptVersions.includes(d.prompt_version)) {
    return reject('MODEL_INCOMPATIBLE', 'prompt version');
  }
  if (!ctx.licenseNoticeIds.includes(d.license_notice_id)) {
    return reject('MODEL_INCOMPATIBLE', 'license notice');
  }
  if ((ctx.knownBad ?? []).includes(d.sha256)) {
    return reject('FILE_DAMAGED', 'known-bad artifact');
  }
  return {ok: true, descriptor: d, payloadSha256};
}
