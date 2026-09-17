// node:test suite for the publication tools. Everything runs against the
// local fault server and temp files; the AWS CLI is never executed (dry-run).
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, {after, before, beforeEach, describe} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createFaultServer} from '../../tools/fault-server/server.mjs';
import {buildPayload, rawPublicKeyB64, signPayloadBytes} from '../descriptor/sign.mjs';
import {buildFixtureGguf} from '../dev/make-fixture-gguf.mjs';
import {
  artifactKey,
  decodeUnverifiedPayload,
  descriptorLockMismatches,
  formatCommand,
  lockProblems,
  parseOrigin,
  sha256HexToBase64,
} from './lib.mjs';
import {preflight} from './preflight.mjs';
import {
  invalidationArgs,
  putDescriptorArgs,
  sequenceDecision,
  validationReportProblems,
} from './publish-descriptor.mjs';
import {headObjectArgs, headObjectProblems, putObjectArgs} from './upload-artifact.mjs';
import {validateDistribution} from './validate-distribution.mjs';
import {loadKeys, verifyEnvelope} from './verify-descriptor.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = 'llamarn-0.12.9-b10256';
const productionLock = {
  schema: 1,
  repo_id: 'CohereLabs/tiny-aya-global-GGUF',
  revision: '0123456789abcdef0123456789abcdef01234567',
  filename: 'tiny-aya-global-q4_k_m.gguf',
  bytes: 2143977056,
  sha256: 'a'.repeat(64),
  architecture: 'cohere2',
  quantization: 'Q4_K_M',
};

let tmp;
let server;
let origin;
let fixtureFile;
let fixtureBytes;
let lock;
let lockFile;
let keysFile;
let privateKey;
let expected;

/** Runs a CLI without blocking the event loop (the fault server lives in this process). */
function run(script, args) {
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(here, script), ...args], {encoding: 'utf8'},
      (error, stdout, stderr) => resolve({status: error ? error.code : 0, stdout, stderr}));
  });
}

function signDescriptor(name, overrides = {}) {
  const payload = buildPayload({
    lock, sequence: 5, artifactVersion: 'fixture-1', runtimeBuildIds: [RUNTIME], minAppBuild: 1,
    maxAppBuild: 100, issuedAt: new Date(Date.now() - 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...overrides,
  });
  const envelope = signPayloadBytes(Buffer.from(JSON.stringify(payload), 'utf8'), privateKey, 'dev-publish-test');
  const file = path.join(tmp, name);
  fs.writeFileSync(file, envelope);
  return file;
}

describe('publication tools', () => {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'namu-publish-'));
    fixtureBytes = buildFixtureGguf({architecture: 'llama', payloadBytes: 300_000});
    fixtureFile = path.join(tmp, 'fixture.gguf');
    fs.writeFileSync(fixtureFile, fixtureBytes);
    lock = {
      schema: 1, repo_id: 'dev/fixture', revision: '0'.repeat(40), filename: 'fixture.gguf',
      bytes: fixtureBytes.length, sha256: crypto.createHash('sha256').update(fixtureBytes).digest('hex'),
      architecture: 'llama', quantization: 'F32',
    };
    lockFile = path.join(tmp, 'fixture.lock.json');
    fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2));
    expected = {path: artifactKey(lock), bytes: lock.bytes, sha256: lock.sha256};

    privateKey = crypto.generateKeyPairSync('ed25519').privateKey;
    keysFile = path.join(tmp, 'release-keys.json');
    fs.writeFileSync(keysFile, JSON.stringify({keys: [{key_id: 'dev-publish-test',
      public_key_b64: rawPublicKeyB64(privateKey)}]}));

    const served = path.join(tmp, 'serve', expected.path);
    fs.mkdirSync(path.dirname(served), {recursive: true});
    fs.writeFileSync(served, fixtureBytes);
    server = createFaultServer({root: path.join(tmp, 'serve'), log: () => {}});
    const {port} = await server.listen({port: 0});
    origin = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await server.close();
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  beforeEach(() => {
    server.setRules([]);
    fs.rmSync(path.join(tmp, 'serve/releases'), {recursive: true, force: true});
  });

  // ---------------------------------------------------------------- lib

  test('lockProblems: a complete production lock passes, anything guessed or partial fails', () => {
    assert.deepEqual(lockProblems(productionLock), []);
    assert.ok(lockProblems({...productionLock, revision: 'main'}).some(p => /40-hex/.test(p)));
    assert.ok(lockProblems({...productionLock, revision: '0123456'}).some(p => /40-hex/.test(p)));
    assert.ok(lockProblems({...productionLock, bytes: 2.14e9 + 0.5}).some(p => /exact positive byte count/.test(p)));
    assert.ok(lockProblems({...productionLock, bytes: '2143977056'}).some(p => /byte count/.test(p)));
    assert.ok(lockProblems({...productionLock, sha256: 'A'.repeat(64)}).some(p => /lowercase hex/.test(p)));
    assert.ok(lockProblems({...productionLock, schema: 2}).some(p => /schema/.test(p)));
    assert.ok(lockProblems({...productionLock, filename: 'tiny-aya-global-q8_0.gguf'}).some(p => /filename/.test(p)));
    assert.ok(lockProblems({...productionLock, quantization: 'Q8_0'}).some(p => /cohere2\/Q4_K_M/.test(p)));
    assert.deepEqual(lockProblems(null), ['lock is not a JSON object']);
    // A fixture lock is refused unless explicitly allowed (staging only).
    assert.ok(lockProblems(lock).length > 0);
    assert.deepEqual(lockProblems(lock, {allowFixture: true}), []);
  });

  test('artifact key and S3 checksum encoding', () => {
    assert.equal(artifactKey(productionLock), `models/aya-global-q4km/${'a'.repeat(64)}/model.gguf`);
    // SHA-256 of the empty string, hex -> base64 as S3 reports it.
    assert.equal(sha256HexToBase64('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
      '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
  });

  test('parseOrigin: https only, except localhost; nothing but scheme://host[:port]', () => {
    assert.equal(parseOrigin('https://distribution.invalid'), 'https://distribution.invalid');
    assert.equal(parseOrigin('https://distribution.invalid/'), 'https://distribution.invalid');
    assert.equal(parseOrigin('http://localhost:8787'), 'http://localhost:8787');
    assert.equal(parseOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
    assert.equal(parseOrigin('http://[::1]:8787'), 'http://[::1]:8787');
    for (const bad of ['http://distribution.invalid', 'http://10.0.2.2:8787', 'ftp://localhost', 'distribution.invalid',
      'https://distribution.invalid/models', 'https://distribution.invalid?x=1', 'https://user:pw@distribution.invalid',
      'https://distribution.invalid/#frag', 'http://localhost.distribution.invalid']) {
      assert.throws(() => parseOrigin(bad), /--origin/, bad);
    }
  });

  test('descriptorLockMismatches pins every lock-derived field', () => {
    const payload = buildPayload({lock: productionLock, sequence: 1, artifactVersion: 'v', runtimeBuildIds: [RUNTIME],
      minAppBuild: 1, maxAppBuild: 2, issuedAt: '2026-09-01T00:00:00Z'});
    assert.deepEqual(descriptorLockMismatches(payload, productionLock), []);
    assert.equal(descriptorLockMismatches({...payload, bytes: payload.bytes + 1}, productionLock).length, 1);
    assert.match(descriptorLockMismatches({...payload, path: 'models/other/model.gguf'}, productionLock)[0], /^path:/);
    assert.equal(descriptorLockMismatches(payload, {...productionLock, revision: 'b'.repeat(40)}).length, 1);
  });

  // ---------------------------------------------------------------- preflight

  test('preflight accepts only the exact locked bytes', async () => {
    const ok = await preflight({lockFile, artifactFile: fixtureFile, allowFixture: true});
    assert.equal(ok.key, expected.path);
    assert.equal(ok.checksumSha256Base64, Buffer.from(lock.sha256, 'hex').toString('base64'));

    await assert.rejects(preflight({lockFile, artifactFile: fixtureFile}), /incomplete \(MDL-003\)/);
    await assert.rejects(preflight({lockFile, artifactFile: path.join(tmp, 'absent.gguf'), allowFixture: true}),
      /artifact not found/);

    const shorter = path.join(tmp, 'shorter.gguf');
    fs.writeFileSync(shorter, fixtureBytes.subarray(0, fixtureBytes.length - 1));
    await assert.rejects(preflight({lockFile, artifactFile: shorter, allowFixture: true}), /size .* differs/);

    const flipped = Buffer.from(fixtureBytes);
    flipped[flipped.length - 1] ^= 1;
    const corrupt = path.join(tmp, 'corrupt.gguf');
    fs.writeFileSync(corrupt, flipped);
    await assert.rejects(preflight({lockFile, artifactFile: corrupt, allowFixture: true}), /SHA-256 .* differs/);

    const placeholder = path.join(tmp, 'placeholder.lock.json');
    fs.writeFileSync(placeholder, JSON.stringify({...productionLock, sha256: 'TBD', bytes: 0}));
    await assert.rejects(preflight({lockFile: placeholder, artifactFile: fixtureFile}), /incomplete \(MDL-003\)/);
  });

  // ---------------------------------------------------------------- upload (dry-run only)

  test('upload-artifact builds the DST-002 put-object command and verifies head-object output', () => {
    const put = putObjectArgs({bucket: 'BUCKET', key: expected.path, file: fixtureFile,
      checksumSha256Base64: sha256HexToBase64(lock.sha256)});
    const text = formatCommand(put);
    assert.match(text, /^aws s3api put-object --region eu-west-1 --bucket BUCKET /);
    assert.ok(text.includes(`--key ${expected.path}`));
    assert.ok(text.includes('--content-type application/octet-stream'));
    assert.ok(text.includes('--cache-control public,max-age=31536000,immutable'));
    assert.ok(text.includes('--checksum-algorithm SHA256'));
    assert.ok(text.includes("--if-none-match '*'"));
    assert.ok(!text.includes('content-encoding'), 'no Content-Encoding is ever set');
    assert.deepEqual(put.slice(0, 2), ['s3api', 'put-object'], 'single PutObject, not the multipart `aws s3 cp`');
    assert.ok(formatCommand(headObjectArgs({bucket: 'BUCKET', key: expected.path})).includes('--checksum-mode ENABLED'));

    const want = {bytes: lock.bytes, checksumSha256Base64: sha256HexToBase64(lock.sha256),
      contentType: 'application/octet-stream', cacheControl: 'public,max-age=31536000,immutable'};
    const good = {ContentLength: lock.bytes, ChecksumSHA256: want.checksumSha256Base64, ChecksumType: 'FULL_OBJECT',
      ContentType: 'application/octet-stream', CacheControl: 'public,max-age=31536000,immutable',
      ETag: '"9b2cf535f27731c974343645a3985328"'};
    assert.deepEqual(headObjectProblems(good, want), []);
    assert.equal(headObjectProblems({...good, ContentLength: 1}, want).length, 1);
    assert.equal(headObjectProblems({...good, ChecksumSHA256: undefined}, want).length, 1);
    assert.equal(headObjectProblems({...good, ChecksumType: 'COMPOSITE'}, want).length, 1);
    assert.equal(headObjectProblems({...good, ContentEncoding: 'gzip'}, want).length, 1);
    assert.equal(headObjectProblems({...good, ContentType: 'binary/octet-stream'}, want).length, 1);
    assert.equal(headObjectProblems({...good, CacheControl: undefined}, want).length, 1);
  });

  test('upload-artifact --dry-run prints the AWS commands and runs nothing', async () => {
    const r = await run('upload-artifact.mjs', ['--bucket', 'BUCKET-FROM-TERRAFORM-OUTPUT', '--lock', lockFile,
      '--artifact', fixtureFile, '--allow-fixture', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /preflight ok/);
    assert.match(r.stdout, /\[dry-run\] aws s3api put-object .*--bucket BUCKET-FROM-TERRAFORM-OUTPUT/);
    assert.match(r.stdout, /\[dry-run\] aws s3api head-object /);
    assert.match(r.stdout, /nothing was uploaded or verified/);

    const refused = await run('upload-artifact.mjs', ['--bucket', 'B', '--lock', lockFile, '--artifact', fixtureFile,
      '--dry-run']);
    assert.notEqual(refused.status, 0, 'a fixture lock needs --allow-fixture');
    const noBucket = await run('upload-artifact.mjs', ['--lock', lockFile, '--artifact', fixtureFile]);
    assert.match(noBucket.stderr, /--bucket is required/);
  });

  // ---------------------------------------------------------------- validate-distribution

  test('validate-distribution passes against a correct origin, including the full download', async () => {
    const result = await validateDistribution({origin, expected, artifactFile: fixtureFile, full: true});
    assert.deepEqual(result.checks.filter(c => !c.ok), []);
    assert.equal(result.ok, true);
    const names = result.checks.map(c => c.name).join('\n');
    for (const needle of ['HEAD Content-Length', 'HEAD no Content-Encoding', 'HEAD Accept-Ranges', 'range at start: 206',
      'range in the middle: Content-Range exact', 'last byte: Content-Range exact', 'open-ended resume range: 206',
      'range beyond EOF: 416', 'If-Range with the current ETag: 206', 'If-Range with a wrong ETag: 200',
      'full GET: SHA-256 equals the locked digest']) {
      assert.ok(names.includes(needle), `missing check: ${needle}`);
    }
  });

  test('validate-distribution fails on each origin defect', async () => {
    const any = '*';
    const cases = [
      [{match: any, fault: 'ignore-range'}, 'range at start: 206'],
      [{match: any, fault: 'wrong-content-range', variant: 'start'}, 'range in the middle: Content-Range exact'],
      [{match: any, fault: 'wrong-content-range', variant: 'total'}, 'last byte: Content-Range exact'],
      [{match: any, fault: 'change-etag'}, 'range at start: same ETag as HEAD'],
      [{match: any, fault: 'gzip'}, 'full GET: no Content-Encoding'],
      [{match: any, fault: 'status-416'}, 'range at start: 206'],
      [{match: any, fault: 'truncate', percent: 50, whenRange: false}, 'full GET: body length is exact'],
      [{match: any, fault: 'oversize', extraBytes: 10, whenRange: false}, 'full GET: body length is exact'],
      [{match: any, fault: 'status', code: 503}, 'range at start: 206'],
      [{match: any, fault: 'redirect', location: 'https://other-origin.invalid/x'}, 'range at start: 206'],
      [{match: any, fault: 'status', code: 404, methods: ['HEAD']}, 'HEAD status 200'],
    ];
    for (const [rule, failingCheck] of cases) {
      server.setRules([rule]);
      const result = await validateDistribution({origin, expected, artifactFile: fixtureFile, full: true});
      assert.equal(result.ok, false, JSON.stringify(rule));
      const failed = result.checks.filter(c => !c.ok).map(c => c.name);
      assert.ok(failed.includes(failingCheck), `${JSON.stringify(rule)} -> expected "${failingCheck}" in ${JSON.stringify(failed)}`);
    }
  });

  test('validate-distribution detects wrong bytes and a wrong digest', async () => {
    const other = Buffer.from(fixtureBytes);
    other[Math.floor(other.length / 2) + 5] ^= 0xff;
    const otherFile = path.join(tmp, 'other.gguf');
    fs.writeFileSync(otherFile, other);
    const byRange = await validateDistribution({origin, expected, artifactFile: otherFile});
    assert.ok(byRange.checks.some(c => !c.ok && c.name === 'range in the middle: bytes equal the local artifact'));

    const byDigest = await validateDistribution({origin, expected: {...expected, sha256: 'b'.repeat(64)}, full: true});
    assert.deepEqual(byDigest.checks.filter(c => !c.ok).map(c => c.name), ['full GET: SHA-256 equals the locked digest']);
  });

  test('validate-distribution CLI: report file, exit codes and origin policy', async () => {
    const report = path.join(tmp, 'validation.json');
    const ok = await run('validate-distribution.mjs', ['--origin', origin, '--lock', lockFile, '--allow-fixture',
      '--artifact', fixtureFile, '--full', '--report', report]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const doc = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(doc.ok, true);
    assert.equal(doc.full_download, true);
    assert.equal(doc.origin, origin);
    assert.equal(doc.sha256, lock.sha256);

    // --descriptor works as the source of expectations too.
    const descriptor = signDescriptor('for-validate.json');
    const byDescriptor = await run('validate-distribution.mjs', ['--origin', origin, '--descriptor', descriptor]);
    assert.equal(byDescriptor.status, 0, byDescriptor.stdout + byDescriptor.stderr);
    assert.match(byDescriptor.stdout, /full download NOT checked/);

    server.setRules([{match: '*', fault: 'ignore-range'}]);
    const failing = await run('validate-distribution.mjs', ['--origin', origin, '--lock', lockFile, '--allow-fixture']);
    assert.equal(failing.status, 1);
    assert.match(failing.stdout, /FAIL {2}range at start: 206/);

    const insecure = await run('validate-distribution.mjs', ['--origin', 'http://distribution.invalid', '--lock', lockFile,
      '--allow-fixture']);
    assert.equal(insecure.status, 2);
    assert.match(insecure.stderr, /must be https/);
    const both = await run('validate-distribution.mjs', ['--origin', origin, '--lock', lockFile, '--descriptor', descriptor]);
    assert.equal(both.status, 2);
  });

  // ---------------------------------------------------------------- descriptor verification and publication

  test('verify-descriptor: accepts a matching descriptor, refuses dev keys for release and lock mismatches', async () => {
    const descriptor = signDescriptor('verify-me.json');
    const base = ['--descriptor', descriptor, '--keys', keysFile, '--runtime-build-id', RUNTIME, '--app-build', '7'];
    const ok = await run('verify-descriptor.mjs', [...base, '--dev-profile', '--lock', lockFile]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).descriptor.sha256, lock.sha256);

    const releaseMode = await run('verify-descriptor.mjs', base);
    assert.equal(releaseMode.status, 2);
    assert.match(releaseMode.stderr, /development key/);
    assert.throws(() => loadKeys(keysFile), /development key/);

    const otherLock = path.join(tmp, 'other.lock.json');
    fs.writeFileSync(otherLock, JSON.stringify({...lock, revision: '1'.repeat(40)}));
    const mismatch = await run('verify-descriptor.mjs', [...base, '--dev-profile', '--lock', otherLock]);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /REJECTED LOCK_MISMATCH: upstream_revision/);

    const tooOldApp = await run('verify-descriptor.mjs', [...base.slice(0, -1), '500', '--dev-profile']);
    assert.equal(tooOldApp.status, 1);
    assert.match(tooOldApp.stderr, /REJECTED MODEL_INCOMPATIBLE/);

    const keys = loadKeys(keysFile, {devProfile: true});
    const replay = verifyEnvelope(fs.readFileSync(descriptor), {keys, runtimeBuildId: RUNTIME, appBuild: 7,
      devProfile: true, highestSequence: 9});
    assert.equal(replay.code, 'SIGNATURE_INVALID');
  });

  test('publish-descriptor helpers: commands, report gate and sequence rule', () => {
    const put = formatCommand(putDescriptorArgs({bucket: 'BUCKET', file: 'stable.json', sha256Hex: 'ab'.repeat(32)}));
    assert.ok(put.includes('--key releases/stable.json'));
    assert.ok(put.includes('--cache-control public,max-age=300'));
    assert.ok(put.includes('--content-type application/json'));
    assert.deepEqual(invalidationArgs({distributionId: 'DIST'}).slice(-2), ['--paths', '/releases/stable.json']);

    const descriptor = {path: expected.path, bytes: expected.bytes, sha256: expected.sha256};
    const report = {tool: 'validate-distribution', ok: true, full_download: true, origin, ...expected};
    assert.deepEqual(validationReportProblems(report, {origin, descriptor}), []);
    assert.equal(validationReportProblems({...report, full_download: false}, {origin, descriptor}).length, 1);
    assert.equal(validationReportProblems({...report, ok: false}, {origin, descriptor}).length, 1);
    assert.equal(validationReportProblems({...report, origin: 'https://staging.invalid'}, {origin, descriptor}).length, 1);
    assert.equal(validationReportProblems({...report, sha256: 'c'.repeat(64)}, {origin, descriptor}).length, 1);
    assert.ok(validationReportProblems(null, {origin, descriptor}).length >= 4);

    const v5 = fs.readFileSync(signDescriptor('seq5.json', {sequence: 5}));
    const v6 = fs.readFileSync(signDescriptor('seq6.json', {sequence: 6}));
    const v5b = fs.readFileSync(signDescriptor('seq5b.json', {sequence: 5, artifactVersion: 'fixture-altered'}));
    assert.equal(decodeUnverifiedPayload(v6).sequence, 6);
    assert.deepEqual(sequenceDecision(null, v5, 5), {action: 'publish', currentSequence: null});
    assert.deepEqual(sequenceDecision(v5, v6, 6), {action: 'publish', currentSequence: 5});
    assert.deepEqual(sequenceDecision(v5, v5, 5), {action: 'already-published', currentSequence: 5});
    assert.throws(() => sequenceDecision(v6, v5, 5), /not higher than the published sequence 6/);
    assert.throws(() => sequenceDecision(v5, v5b, 5), /not higher/);
  });

  test('publish-descriptor --dry-run enforces the DST-003 order end to end', async () => {
    const report = path.join(tmp, 'gate-report.json');
    const validated = await run('validate-distribution.mjs', ['--origin', origin, '--lock', lockFile, '--allow-fixture',
      '--full', '--report', report]);
    assert.equal(validated.status, 0, validated.stdout + validated.stderr);

    const v5 = signDescriptor('publish-5.json', {sequence: 5});
    const base = ['--bucket', 'BUCKET', '--origin', origin, '--keys', keysFile, '--lock', lockFile,
      '--validation-report', report, '--runtime-build-id', RUNTIME, '--app-build', '7', '--dev-profile', '--dry-run'];

    // Nothing published yet: must be acknowledged explicitly.
    const needsFlag = await run('publish-descriptor.mjs', [...base, '--descriptor', v5]);
    assert.notEqual(needsFlag.status, 0);
    assert.match(needsFlag.stderr, /--first-release/);

    const first = await run('publish-descriptor.mjs', [...base, '--descriptor', v5, '--first-release',
      '--distribution-id', 'DISTRIBUTION-ID-FROM-OUTPUT']);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /\[dry-run\] aws s3api put-object .*--key releases\/stable\.json .*--cache-control public,max-age=300/);
    assert.match(first.stdout, /\[dry-run\] aws cloudfront create-invalidation --distribution-id DISTRIBUTION-ID-FROM-OUTPUT --paths \/releases\/stable\.json/);
    assert.match(first.stdout, /nothing was published/);

    // Pretend sequence 5 is live, then try a replay, a same-sequence change and a rollback.
    fs.mkdirSync(path.join(tmp, 'serve/releases'), {recursive: true});
    fs.copyFileSync(v5, path.join(tmp, 'serve/releases/stable.json'));
    const same = await run('publish-descriptor.mjs', [...base, '--descriptor', v5]);
    assert.equal(same.status, 0);
    assert.match(same.stdout, /already serves exactly this descriptor/);
    const altered = await run('publish-descriptor.mjs', [...base, '--descriptor',
      signDescriptor('publish-5-altered.json', {sequence: 5, artifactVersion: 'fixture-altered'})]);
    assert.notEqual(altered.status, 0);
    assert.match(altered.stderr, /not higher than the published sequence 5/);
    const rollback = await run('publish-descriptor.mjs', [...base, '--descriptor',
      signDescriptor('publish-6-rollback.json', {sequence: 6, artifactVersion: 'fixture-0-known-good'})]);
    assert.equal(rollback.status, 0, rollback.stdout + rollback.stderr);
    assert.match(rollback.stdout, /published sequence: 5 -> new sequence: 6/);

    // No passing --full report, no publication.
    const partial = path.join(tmp, 'partial-report.json');
    fs.writeFileSync(partial, JSON.stringify({...JSON.parse(fs.readFileSync(report, 'utf8')), full_download: false}));
    const gated = await run('publish-descriptor.mjs', [...base.map(v => (v === report ? partial : v)), '--descriptor',
      signDescriptor('publish-7.json', {sequence: 7})]);
    assert.notEqual(gated.status, 0);
    assert.match(gated.stderr, /lacks the full download check/);

    // An expired descriptor is never published.
    const expired = await run('publish-descriptor.mjs', [...base, '--descriptor',
      signDescriptor('publish-expired.json', {sequence: 8, issuedAt: '2025-01-01T00:00:00Z', validDays: 30})]);
    assert.notEqual(expired.status, 0);
    assert.match(expired.stderr, /descriptor rejected \(SIGNATURE_INVALID\): expired/);
  });
});
