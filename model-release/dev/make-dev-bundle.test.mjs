// node:test suite for the development bundle tooling: the synthesized GGUF
// fixture, the bounded GGUF header reader and make-dev-bundle.mjs --out-only.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, {after, before, describe} from 'node:test';
import {fileURLToPath} from 'node:url';
import {verifyDescriptor} from '../descriptor/verify.mjs';
import {GgufError, readGgufArchitecture} from './gguf-header.mjs';
import {buildFixtureGguf} from './make-fixture-gguf.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const RUNTIME = 'llamarn-0.12.9-b10256';
let tmp;

const write = (name, bytes) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, bytes);
  return file;
};

/** Snapshot of the generated trust files in the native projects (they may not exist). */
function nativeTrustFiles() {
  const dirs = [path.join(root, 'android/app/src/main/assets/namu'), path.join(root, 'ios/Namu/NamuConfig')];
  const snapshot = {};
  for (const dir of dirs) {
    for (const name of ['initial-descriptor.json', 'release-keys.json', 'known-bad.json']) {
      const file = path.join(dir, name);
      snapshot[file] = fs.existsSync(file)
        ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
        : null;
    }
  }
  return snapshot;
}

describe('development bundle tools', () => {
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'namu-dev-bundle-'));
  });

  after(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  test('fixture GGUF is deterministic and carries general.architecture', () => {
    const a = buildFixtureGguf({architecture: 'llama', payloadBytes: 4096});
    const b = buildFixtureGguf({architecture: 'llama', payloadBytes: 4096});
    assert.ok(a.equals(b));
    assert.equal(a.subarray(0, 4).toString('latin1'), 'GGUF');
    assert.equal(a.readUInt32LE(4), 3);
    assert.equal((a.length - 4096) % 32, 0, 'metadata is padded to the GGUF alignment');
    assert.equal(readGgufArchitecture(write('llama.gguf', a)), 'llama');
    assert.equal(readGgufArchitecture(write('cohere2.gguf', buildFixtureGguf({architecture: 'cohere2'}))), 'cohere2');
    assert.equal(readGgufArchitecture(write('v2.gguf', buildFixtureGguf({version: 2}))), 'llama');
  });

  test('GGUF header reader rejects malformed files without reading tensor data', () => {
    const good = buildFixtureGguf();
    const mutate = fn => {
      const copy = Buffer.from(good);
      fn(copy);
      return copy;
    };
    const cases = {
      'bad magic': [mutate(b => b.write('GGML', 0, 'latin1')), /bad magic/],
      'unsupported version': [mutate(b => b.writeUInt32LE(1, 4)), /unsupported version/],
      'tensor count out of bounds': [mutate(b => b.writeBigUInt64LE(65537n, 8)), /counts out of bounds/],
      'kv count out of bounds': [mutate(b => b.writeBigUInt64LE(4097n, 16)), /counts out of bounds/],
      // First pair is general.alignment: 8-byte length + 17-byte key, then the u32 value type at offset 49.
      'unknown value type': [mutate(b => b.writeUInt32LE(99, 49)), /unknown value type 99/],
      'nested array': [Buffer.concat([good.subarray(0, 16), (() => {
        const kv = Buffer.alloc(8 + 1 + 4 + 4 + 8 + 4 + 8);
        kv.writeBigUInt64LE(1n, 0);
        kv.write('k', 8, 'latin1');
        kv.writeUInt32LE(9, 9); // array
        kv.writeUInt32LE(9, 13); // of arrays
        kv.writeBigUInt64LE(1n, 17);
        kv.writeUInt32LE(9, 25); // of arrays again
        kv.writeBigUInt64LE(1n, 29);
        const count = Buffer.alloc(8);
        count.writeBigUInt64LE(1n);
        return Buffer.concat([count, kv]);
      })()]), /nested arrays not allowed|exceeds header window/],
      'truncated header': [good.subarray(0, 40), /exceeds header window/],
      'empty file': [Buffer.alloc(0), /exceeds header window/],
      'huge key length': [mutate(b => b.writeBigUInt64LE(0xffffffffffffffffn, 24)), /out of range|too long/],
    };
    for (const [name, [bytes, pattern]] of Object.entries(cases)) {
      assert.throws(() => readGgufArchitecture(write('bad.gguf', bytes)), error => {
        assert.ok(error instanceof GgufError, `${name}: ${error}`);
        assert.match(error.message, pattern, name);
        return true;
      }, name);
    }
    // Architecture missing entirely: drop the last key/value pair.
    const noArch = mutate(b => b.writeBigUInt64LE(7n, 16));
    assert.throws(() => readGgufArchitecture(write('noarch.gguf', noArch)), /general\.architecture missing/);
  });

  test('make-dev-bundle --out-only writes a verifiable bundle and leaves android/ and ios/ alone', () => {
    const model = write('fixture.gguf', buildFixtureGguf({architecture: 'llama', payloadBytes: 100_000}));
    const out = path.join(tmp, 'out');
    const before = nativeTrustFiles();
    const run = spawnSync(process.execPath, [path.join(here, 'make-dev-bundle.mjs'), '--model', model,
      '--quantization', 'F32', '--artifact-version', 'dev-test', '--sequence', '4', '--out-only', '--out', out],
    {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(nativeTrustFiles(), before, 'native project trust files must be untouched');

    const summary = JSON.parse(run.stdout);
    const bytes = fs.readFileSync(model);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(summary.sha256, sha256);
    assert.equal(summary.bytes, bytes.length);
    assert.equal(summary.architecture, 'llama');
    assert.equal(summary.profile, 'development fixture');
    assert.deepEqual(summary.installedInto, [out]);
    assert.equal(summary.artifact, `models/aya-global-q4km/${sha256}/model.gguf`);

    // Trust files.
    const keys = JSON.parse(fs.readFileSync(path.join(out, 'release-keys.json'), 'utf8')).keys;
    assert.equal(keys.length, 1);
    assert.ok(keys[0].key_id.startsWith('dev-'), 'development keys are recognisable so release builds can refuse them');
    assert.equal(Buffer.from(keys[0].public_key_b64, 'base64').length, 32);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'known-bad.json'), 'utf8')), {sha256: []});
    assert.equal(fs.statSync(path.join(out, 'dev-signing-key.pem')).mode & 0o077, 0, 'dev key is owner-only');

    // The served tree is what the fault server and the app expect.
    assert.ok(fs.readFileSync(path.join(out, 'serve', summary.artifact)).equals(bytes));
    const envelope = fs.readFileSync(path.join(out, 'initial-descriptor.json'));
    assert.ok(fs.readFileSync(path.join(out, 'serve/releases/stable.json')).equals(envelope));

    const ctx = {
      keys, source: 'bundled', appBuild: 1, runtimeBuildId: RUNTIME, promptVersions: ['namu-text-2'],
      licenseNoticeIds: ['tiny-aya-cc-by-nc-4.0-v1'], nowMs: Date.now(), knownBad: [],
    };
    // Internal fixture profile accepts it ...
    const internal = verifyDescriptor(envelope, {...ctx,
      profile: {architectures: ['cohere2', 'llama'], quantizations: ['Q4_K_M', 'Q8_0', 'F16', 'F32']}});
    assert.equal(internal.ok, true, internal.reason);
    assert.equal(internal.descriptor.sequence, 4);
    assert.equal(internal.descriptor.artifact_version, 'dev-test');
    assert.equal(internal.descriptor.bytes, bytes.length);
    assert.equal(internal.descriptor.sha256, sha256);
    // ... and the production profile refuses the fixture (REL-001).
    assert.equal(verifyDescriptor(envelope, ctx).code, 'MODEL_INCOMPATIBLE');

    // A second run reuses the same development key.
    const again = spawnSync(process.execPath, [path.join(here, 'make-dev-bundle.mjs'), '--model', model,
      '--quantization', 'F32', '--out-only', '--out', out], {encoding: 'utf8'});
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'release-keys.json'), 'utf8')).keys, keys);
  });

  test('make-dev-bundle fails clearly for a file that is not GGUF or a missing --model', () => {
    const notGguf = write('not-a-model.bin', crypto.randomBytes(256));
    const run = spawnSync(process.execPath, [path.join(here, 'make-dev-bundle.mjs'), '--model', notGguf,
      '--out-only', '--out', path.join(tmp, 'out-bad')], {encoding: 'utf8'});
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /bad magic/);
    assert.ok(!fs.existsSync(path.join(tmp, 'out-bad/initial-descriptor.json')));

    const missing = spawnSync(process.execPath, [path.join(here, 'make-dev-bundle.mjs'), '--out-only'], {encoding: 'utf8'});
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /--model <file\.gguf> is required/);
  });

  test('make-fixture-gguf CLI writes the same bytes as the library', () => {
    const out = path.join(tmp, 'cli.gguf');
    const run = spawnSync(process.execPath, [path.join(here, 'make-fixture-gguf.mjs'), '--out', out,
      '--architecture', 'llama', '--payload-bytes', '1000'], {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr);
    const expected = buildFixtureGguf({architecture: 'llama', payloadBytes: 1000});
    assert.ok(fs.readFileSync(out).equals(expected));
    const summary = JSON.parse(run.stdout);
    assert.equal(summary.sha256, crypto.createHash('sha256').update(expected).digest('hex'));
    assert.equal(summary.loadable, false);
  });
});
