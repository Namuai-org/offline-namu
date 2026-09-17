#!/usr/bin/env node
// Publication step (c): verify full and range downloads through the
// distribution BEFORE any descriptor points at the artifact (DST-003, D09).
//
//   node model-release/publish/validate-distribution.mjs \
//     --origin https://<distribution domain from terraform output> \
//     (--lock model-release/model.lock.json | --descriptor releases/stable.json) \
//     [--artifact <local file>]   compare every range with the local bytes
//     [--full]                    also stream the whole object and hash it (~2 GB)
//     [--report <file.json>]      evidence for publish-descriptor.mjs / REL-003
//
// Plain HTTP(S) GET/HEAD only; no AWS credentials. The origin must be https
// unless it is localhost (the fault server). Redirects are never followed and
// `Accept-Encoding: identity` is always sent, exactly like the app (DL-003).
//
// --descriptor is decoded WITHOUT signature verification: it only tells this
// tool which path/bytes/sha256 to expect. Use verify-descriptor.mjs for trust.
import crypto from 'node:crypto';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {
  ARTIFACT_CACHE_CONTROL,
  ARTIFACT_CONTENT_TYPE,
  artifactKey,
  decodeUnverifiedPayload,
  parseOrigin,
  probe,
  readLock,
} from './lib.mjs';

const RANGE_BYTES = 1024;

function expectationFrom({lockFile, descriptorFile, allowFixture}) {
  if ((lockFile === undefined) === (descriptorFile === undefined)) {
    throw new Error('give exactly one of --lock or --descriptor');
  }
  if (lockFile !== undefined) {
    const lock = readLock(lockFile, {allowFixture});
    return {path: artifactKey(lock), bytes: lock.bytes, sha256: lock.sha256, source: 'lock'};
  }
  const d = decodeUnverifiedPayload(fs.readFileSync(descriptorFile));
  if (typeof d.path !== 'string' || !/^[A-Za-z0-9._/-]{1,512}$/.test(d.path) || d.path.startsWith('/') ||
      d.path.split('/').some(s => s === '' || s === '.' || s === '..') ||
      !Number.isSafeInteger(d.bytes) || d.bytes <= 0 || !/^[0-9a-f]{64}$/.test(d.sha256 ?? '')) {
    throw new Error('descriptor payload lacks a usable path/bytes/sha256');
  }
  return {path: d.path, bytes: d.bytes, sha256: d.sha256, source: 'descriptor (signature not checked here)'};
}

function readLocal(file, start, end) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(end - start + 1);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Runs every check and returns a report; throws only for unusable arguments.
 * @returns {Promise<{ok: boolean, checks: {name: string, ok: boolean, detail: string}[]}>}
 */
export async function validateDistribution({origin, expected, artifactFile = null, full = false,
  log = () => {}}) {
  const url = `${parseOrigin(origin)}/${expected.path}`;
  const B = expected.bytes;
  const checks = [];
  const record = (name, ok, detail = '') => {
    checks.push({name, ok, detail});
    log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    return ok;
  };
  const attempt = async (name, fn) => {
    try {
      await fn();
    } catch (error) {
      record(name, false, `request failed: ${error.message}`);
    }
  };
  if (artifactFile !== null && fs.statSync(artifactFile).size !== B) {
    throw new Error('--artifact size differs from the expected byte count; run preflight first');
  }

  // ---- HEAD -------------------------------------------------------------
  let etag = null;
  await attempt('HEAD', async () => {
    const r = await probe(url, {method: 'HEAD'});
    record('HEAD status 200', r.status === 200, `status ${r.status}`);
    record('HEAD Content-Length is the exact byte count', r.headers['content-length'] === String(B),
      `${r.headers['content-length']} vs ${B}`);
    record('HEAD Content-Type application/octet-stream', r.headers['content-type'] === ARTIFACT_CONTENT_TYPE,
      String(r.headers['content-type']));
    record('HEAD no Content-Encoding', r.headers['content-encoding'] === undefined ||
      r.headers['content-encoding'] === 'identity', String(r.headers['content-encoding']));
    record('HEAD Cache-Control immutable for one year',
      (r.headers['cache-control'] ?? '').replace(/\s+/g, '').toLowerCase() === ARTIFACT_CACHE_CONTROL,
      String(r.headers['cache-control']));
    record('HEAD Accept-Ranges: bytes', r.headers['accept-ranges'] === 'bytes', String(r.headers['accept-ranges']));
    etag = r.headers.etag ?? null;
    record('HEAD strong ETag present (needed for If-Range resume)',
      typeof etag === 'string' && /^"[^"]+"$/.test(etag), String(etag));
  });

  // ---- single range requests ---------------------------------------------
  const rangeCheck = async (label, header, start, end, extraHeaders = {}) => {
    await attempt(label, async () => {
      const r = await probe(url, {headers: {Range: header, ...extraHeaders}, maxBody: end - start + 1});
      const okStatus = record(`${label}: 206`, r.status === 206, `status ${r.status}`);
      record(`${label}: Content-Range exact`, r.headers['content-range'] === `bytes ${start}-${end}/${B}`,
        `${r.headers['content-range']} vs bytes ${start}-${end}/${B}`);
      record(`${label}: Content-Length ${end - start + 1}`,
        r.headers['content-length'] === String(end - start + 1), String(r.headers['content-length']));
      record(`${label}: no Content-Encoding`, r.headers['content-encoding'] === undefined ||
        r.headers['content-encoding'] === 'identity', String(r.headers['content-encoding']));
      if (etag !== null) {
        record(`${label}: same ETag as HEAD`, r.headers.etag === etag, String(r.headers.etag));
      }
      if (okStatus) {
        record(`${label}: body length`, r.bodyBytes === end - start + 1 && !r.stoppedEarly, `${r.bodyBytes} bytes`);
        if (artifactFile !== null) {
          record(`${label}: bytes equal the local artifact`, r.body.equals(readLocal(artifactFile, start, end)));
        } else if (start === 0 && end >= 3) {
          record(`${label}: starts with GGUF magic`, r.body.subarray(0, 4).toString('latin1') === 'GGUF');
        }
      }
    });
  };
  const n = Math.min(RANGE_BYTES, B);
  const middle = Math.floor(B / 2);
  await rangeCheck('range at start', `bytes=0-${n - 1}`, 0, n - 1);
  await rangeCheck('range in the middle', `bytes=${middle}-${Math.min(B - 1, middle + n - 1)}`,
    middle, Math.min(B - 1, middle + n - 1));
  await rangeCheck('last byte', `bytes=${B - 1}-${B - 1}`, B - 1, B - 1);
  await rangeCheck('open-ended resume range', `bytes=${B - n}-`, B - n, B - 1);

  // ---- beyond EOF -----------------------------------------------------------
  await attempt('range beyond EOF', async () => {
    const r = await probe(url, {headers: {Range: `bytes=${B}-`}, maxBody: 64 * 1024});
    record('range beyond EOF: 416', r.status === 416, `status ${r.status}`);
    record('range beyond EOF: Content-Range bytes */length', r.headers['content-range'] === `bytes */${B}`,
      String(r.headers['content-range']));
  });

  // ---- If-Range -------------------------------------------------------------
  if (etag !== null) {
    await rangeCheck('If-Range with the current ETag', `bytes=${B - n}-`, B - n, B - 1, {'If-Range': etag});
    await attempt('If-Range with a wrong ETag', async () => {
      const r = await probe(url, {
        headers: {Range: `bytes=${B - n}-`, 'If-Range': '"namu-validation-deliberately-wrong-etag"'},
        maxBody: 64 * 1024,
      });
      record('If-Range with a wrong ETag: 200 (full representation, never 206)', r.status === 200,
        `status ${r.status}`);
      record('If-Range with a wrong ETag: no Content-Range', r.headers['content-range'] === undefined,
        String(r.headers['content-range']));
      record('If-Range with a wrong ETag: full Content-Length', r.headers['content-length'] === String(B),
        String(r.headers['content-length']));
    });
  } else {
    record('If-Range checks', false, 'skipped: no ETag to test with');
  }

  // ---- full download ----------------------------------------------------------
  if (full) {
    await attempt('full GET', async () => {
      const hash = crypto.createHash('sha256');
      let lastLogged = 0;
      let seen = 0;
      const r = await probe(url, {
        maxBody: B, // stop as soon as the body exceeds the expected size
        timeoutMs: 120_000,
        onData: chunk => {
          hash.update(chunk);
          seen += chunk.length;
          if (seen - lastLogged >= 256 * 1024 * 1024) {
            lastLogged = seen;
            log(`      ... ${seen} / ${B} bytes`);
          }
        },
      });
      record('full GET: 200', r.status === 200, `status ${r.status}`);
      record('full GET: no Content-Encoding', r.headers['content-encoding'] === undefined ||
        r.headers['content-encoding'] === 'identity', String(r.headers['content-encoding']));
      record('full GET: Content-Length is the exact byte count', r.headers['content-length'] === String(B),
        String(r.headers['content-length']));
      record('full GET: body length is exact', r.bodyBytes === B && r.complete && !r.stoppedEarly,
        `${r.bodyBytes} bytes, complete=${r.complete}`);
      const digest = hash.digest('hex');
      record('full GET: SHA-256 equals the locked digest', r.bodyBytes === B && digest === expected.sha256, digest);
    });
  }

  return {ok: checks.every(c => c.ok), checks};
}

async function main() {
  const {values: args} = parseArgs({
    options: {
      origin: {type: 'string'},
      lock: {type: 'string'},
      descriptor: {type: 'string'},
      artifact: {type: 'string'},
      full: {type: 'boolean', default: false},
      report: {type: 'string'},
      'allow-fixture': {type: 'boolean', default: false},
    },
  });
  if (!args.origin) {
    throw new Error('--origin is required (terraform output model_origin)');
  }
  const origin = parseOrigin(args.origin);
  const expected = expectationFrom({
    lockFile: args.lock, descriptorFile: args.descriptor, allowFixture: args['allow-fixture'],
  });
  console.log(`validating ${origin}/${expected.path}`);
  console.log(`expecting ${expected.bytes} bytes, sha256 ${expected.sha256} (from ${expected.source})`);
  const result = await validateDistribution({
    origin, expected, artifactFile: args.artifact ?? null, full: args.full, log: line => console.log(line),
  });
  const failed = result.checks.filter(c => !c.ok);
  console.log(`${result.checks.length - failed.length} passed, ${failed.length} failed` +
    (args.full ? '' : '  (full download NOT checked; rerun with --full before publishing a descriptor)'));
  if (args.report) {
    fs.writeFileSync(args.report, JSON.stringify({
      tool: 'validate-distribution',
      generated_at: new Date().toISOString(),
      origin,
      path: expected.path,
      bytes: expected.bytes,
      sha256: expected.sha256,
      full_download: args.full,
      ok: result.ok,
      checks: result.checks,
    }, null, 2) + '\n');
    console.log(`report written: ${args.report}`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`validation aborted: ${error.message}`);
    process.exit(2);
  });
}
