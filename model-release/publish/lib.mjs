// Shared helpers for the model publication tools (PRD section 6, DST-002/003).
// Node built-ins only. The AWS CLI is reached through runAws() and nowhere
// else, so every command that can touch an AWS account is easy to audit.
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import {RELEASE_FAMILY} from '../descriptor/sign.mjs';

export const UPSTREAM_REPO = 'CohereLabs/tiny-aya-global-GGUF';
export const UPSTREAM_FILENAME = 'tiny-aya-global-q4_k_m.gguf';
export const ARTIFACT_CONTENT_TYPE = 'application/octet-stream';
export const ARTIFACT_CACHE_CONTROL = 'public,max-age=31536000,immutable';
export const DESCRIPTOR_KEY = 'releases/stable.json';
export const DESCRIPTOR_CONTENT_TYPE = 'application/json';
export const DESCRIPTOR_CACHE_CONTROL = 'public,max-age=300';
export const BUCKET_REGION = 'eu-west-1';

// --------------------------------------------------------------------------
// model.lock.json (MDL-003)
// --------------------------------------------------------------------------

/**
 * Returns the list of problems with a lock; empty means complete.
 * allowFixture relaxes only the identity fields, for pushing a small fixture
 * through a STAGING distribution. Size and digest are always required.
 */
export function lockProblems(lock, {allowFixture = false} = {}) {
  const problems = [];
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) {
    return ['lock is not a JSON object'];
  }
  if (lock.schema !== 1) {
    problems.push('schema must be 1');
  }
  if (typeof lock.revision !== 'string' || !/^[0-9a-f]{40}$/.test(lock.revision)) {
    problems.push('revision must be the full 40-hex upstream commit');
  }
  if (!Number.isSafeInteger(lock.bytes) || lock.bytes <= 0) {
    problems.push('bytes must be the exact positive byte count');
  }
  if (typeof lock.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(lock.sha256)) {
    problems.push('sha256 must be 64 lowercase hex characters');
  }
  for (const field of ['repo_id', 'filename', 'architecture', 'quantization']) {
    if (typeof lock[field] !== 'string' || lock[field] === '') {
      problems.push(`${field} is missing`);
    }
  }
  if (!allowFixture) {
    if (lock.repo_id !== UPSTREAM_REPO) {
      problems.push(`repo_id must be ${UPSTREAM_REPO}`);
    }
    if (lock.filename !== UPSTREAM_FILENAME) {
      problems.push(`filename must be ${UPSTREAM_FILENAME}`);
    }
    if (lock.architecture !== 'cohere2' || lock.quantization !== 'Q4_K_M') {
      problems.push('architecture/quantization must be cohere2/Q4_K_M');
    }
  }
  return problems;
}

export function readLock(file, options) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read model lock ${file}: ${e.message}`);
  }
  const problems = lockProblems(lock, options);
  if (problems.length > 0) {
    throw new Error(`model lock ${file} is incomplete (MDL-003):\n  - ${problems.join('\n  - ')}`);
  }
  return lock;
}

/** DST-002: the immutable object key, derived only from the verified digest. */
export function artifactKey(lock) {
  return `models/${RELEASE_FAMILY}/${lock.sha256}/model.gguf`;
}

// --------------------------------------------------------------------------
// Hashing
// --------------------------------------------------------------------------

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    fs.createReadStream(file, {highWaterMark: 8 * 1024 * 1024})
      .on('data', chunk => {
        hash.update(chunk);
        bytes += chunk.length;
      })
      .on('error', reject)
      .on('end', () => resolve({sha256: hash.digest('hex'), bytes}));
  });
}

/** S3 additional checksums are base64 of the raw digest, not hex. */
export function sha256HexToBase64(hex) {
  return Buffer.from(hex, 'hex').toString('base64');
}

// --------------------------------------------------------------------------
// Descriptors
// --------------------------------------------------------------------------

/**
 * Decodes the payload of an envelope WITHOUT verifying the signature. Use
 * only to learn where to look (path/bytes/sequence); trust decisions go
 * through descriptor/verify.mjs.
 */
export function decodeUnverifiedPayload(envelopeBytes) {
  const envelope = JSON.parse(Buffer.from(envelopeBytes).toString('utf8'));
  if (typeof envelope?.payload_b64 !== 'string') {
    throw new Error('not a descriptor envelope (payload_b64 missing)');
  }
  return JSON.parse(Buffer.from(envelope.payload_b64, 'base64').toString('utf8'));
}

export function descriptorLockMismatches(descriptor, lock) {
  const expected = {
    path: artifactKey(lock),
    bytes: lock.bytes,
    sha256: lock.sha256,
    upstream_repo: lock.repo_id,
    upstream_revision: lock.revision,
    upstream_filename: lock.filename,
    architecture: lock.architecture,
    quantization: lock.quantization,
  };
  return Object.entries(expected)
    .filter(([field, value]) => descriptor[field] !== value)
    .map(([field, value]) => `${field}: descriptor has ${JSON.stringify(descriptor[field])}, lock requires ${JSON.stringify(value)}`);
}

// --------------------------------------------------------------------------
// Origin handling and a small HTTP probe
// --------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** MODEL_ORIGIN: https://host[:port], nothing else. Plain http only for localhost. */
export function parseOrigin(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`--origin is not a URL: ${text}`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('--origin must be scheme://host[:port] with no path, query, fragment or credentials');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error('--origin must be https (plain http is accepted for localhost only)');
  }
  return url.origin;
}

/**
 * One HTTP request. Never follows redirects, never asks for a content coding,
 * and stops reading once maxBody bytes have arrived (so a wrong 200 for a
 * 2 GB object costs only a few KiB).
 * @returns {Promise<{status: number, headers: object, body: Buffer, bodyBytes: number, complete: boolean, stoppedEarly: boolean}>}
 */
export function probe(url, {method = 'GET', headers = {}, maxBody = 1024 * 1024, onData = null,
  timeoutMs = 60_000} = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const chunks = [];
    let bodyBytes = 0;
    let stoppedEarly = false;
    const req = client.request(url, {
      method,
      agent: false,
      headers: {'Accept-Encoding': 'identity', 'User-Agent': 'namu-model-release', ...headers},
    }, res => {
      const done = () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), bodyBytes,
        complete: res.complete, stoppedEarly,
      });
      res.on('data', chunk => {
        bodyBytes += chunk.length;
        if (onData) {
          onData(chunk);
        } else {
          chunks.push(chunk);
        }
        if (bodyBytes > maxBody) {
          stoppedEarly = true;
          req.destroy();
        }
      });
      res.on('error', () => {});
      res.on('close', done);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response activity for ${timeoutMs} ms`)));
    req.on('error', error => {
      if (!stoppedEarly) {
        reject(error);
      }
    });
    req.end();
  });
}

// --------------------------------------------------------------------------
// AWS CLI boundary
// --------------------------------------------------------------------------

function shellQuote(arg) {
  return /^[A-Za-z0-9_./:=,@+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

export function formatCommand(args) {
  return ['aws', ...args].map(shellQuote).join(' ');
}

/**
 * The only place these tools execute the AWS CLI. Credentials come from the
 * operator's environment (the publisher role); they are never read, written
 * or logged here. With dryRun the command is printed and nothing runs.
 * @returns {{ran: boolean, status: number, stdout: string, stderr: string}}
 */
export function runAws(args, {dryRun = false, log = console.log} = {}) {
  log(`${dryRun ? '[dry-run] ' : '$ '}${formatCommand(args)}`);
  if (dryRun) {
    return {ran: false, status: 0, stdout: '', stderr: ''};
  }
  const result = spawnSync('aws', args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  if (result.error) {
    throw new Error(`could not run the AWS CLI: ${result.error.message}`);
  }
  return {ran: true, status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr};
}
