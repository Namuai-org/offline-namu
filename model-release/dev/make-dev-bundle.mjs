#!/usr/bin/env node
// Development tool: produce the three bundled trust files for INTERNAL builds
// from any local GGUF, signed with a throwaway development key.
//
//   node model-release/dev/make-dev-bundle.mjs --model path/to/model.gguf
//        [--out-only] [--out <dir>]
//
// --out-only writes only the output directory and leaves the Android assets
// and iOS bundle configuration untouched (used by tests and by the fault
// server workflow). --out replaces the default output directory
// model-release/dev/out.
//
// Outputs (git-ignored):
//   model-release/dev/out/initial-descriptor.json
//   model-release/dev/out/release-keys.json
//   model-release/dev/out/known-bad.json
//   model-release/dev/out/serve/<path from descriptor>   (hard link/copy of the model)
//   model-release/dev/out/serve/releases/stable.json
// and copies the three trust files into the Android assets and iOS bundle
// config directories.
//
// The development key is generated locally on first use and stored in
// model-release/dev/out/dev-signing-key.pem (git-ignored). Release builds
// refuse any key whose key_id starts with "dev-".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {rawPublicKeyB64, signPayloadBytes, buildPayload} from '../descriptor/sign.mjs';
import {verifyDescriptor} from '../descriptor/verify.mjs';
import {readGgufArchitecture} from './gguf-header.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const RUNTIME_BUILD_ID = 'llamarn-0.12.9-b10256';
const KEY_ID = 'dev-namu-local';

const {values: args} = parseArgs({
  options: {
    model: {type: 'string'},
    sequence: {type: 'string', default: '1'},
    'artifact-version': {type: 'string', default: 'dev-1'},
    quantization: {type: 'string', default: 'Q4_K_M'},
    'out-only': {type: 'boolean', default: false},
    out: {type: 'string'},
  },
});
if (!args.model) {
  throw new Error('--model <file.gguf> is required');
}
const out = args.out ? path.resolve(args.out) : path.join(here, 'out');

fs.mkdirSync(out, {recursive: true});
const keyFile = path.join(out, 'dev-signing-key.pem');
if (!fs.existsSync(keyFile)) {
  const {privateKey} = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(keyFile, privateKey.export({format: 'pem', type: 'pkcs8'}), {mode: 0o600});
}
const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile));

const stat = fs.statSync(args.model);
const hash = crypto.createHash('sha256');
const fd = fs.openSync(args.model, 'r');
const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
for (let read; (read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0; ) {
  hash.update(buffer.subarray(0, read));
}
fs.closeSync(fd);
const sha256 = hash.digest('hex');
const architecture = readGgufArchitecture(args.model);

const lockPath = path.join(root, 'model-release/model.lock.json');
const realLock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : null;
const isLockedArtifact = realLock && realLock.sha256 === sha256 && realLock.bytes === stat.size;
const lock = isLockedArtifact
  ? realLock
  : {
      repo_id: 'dev/fixture',
      revision: '0'.repeat(40),
      filename: path.basename(args.model),
      bytes: stat.size,
      sha256,
      architecture,
      quantization: args.quantization,
    };

const payload = buildPayload({
  lock,
  sequence: Number(args.sequence),
  artifactVersion: args['artifact-version'],
  runtimeBuildIds: [RUNTIME_BUILD_ID],
  minAppBuild: 1,
  maxAppBuild: 999999,
  issuedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
});
const envelope = signPayloadBytes(Buffer.from(JSON.stringify(payload), 'utf8'), privateKey, KEY_ID);
const keys = {keys: [{key_id: KEY_ID, public_key_b64: rawPublicKeyB64(privateKey)}]};

const check = verifyDescriptor(Buffer.from(envelope), {
  keys: keys.keys, source: 'bundled', appBuild: 1, runtimeBuildId: RUNTIME_BUILD_ID,
  promptVersions: ['namu-text-2'], licenseNoticeIds: ['tiny-aya-cc-by-nc-4.0-v1'],
  nowMs: Date.now(), knownBad: [],
  profile: {architectures: [lock.architecture], quantizations: [lock.quantization]},
});
if (!check.ok) {
  throw new Error(`generated descriptor does not verify: ${check.reason}`);
}

const files = {
  'initial-descriptor.json': envelope,
  'release-keys.json': JSON.stringify(keys, null, 2) + '\n',
  'known-bad.json': JSON.stringify({sha256: []}, null, 2) + '\n',
};
const targets = args['out-only']
  ? [out]
  : [
      out,
      path.join(root, 'android/app/src/main/assets/namu'),
      path.join(root, 'ios/Namu/NamuConfig'),
    ];
for (const dir of targets) {
  fs.mkdirSync(dir, {recursive: true});
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

const served = path.join(out, 'serve', payload.path);
fs.mkdirSync(path.dirname(served), {recursive: true});
fs.rmSync(served, {force: true});
try {
  fs.linkSync(path.resolve(args.model), served);
} catch {
  fs.copyFileSync(args.model, served);
}
fs.mkdirSync(path.join(out, 'serve/releases'), {recursive: true});
fs.writeFileSync(path.join(out, 'serve/releases/stable.json'), envelope);

console.log(JSON.stringify({
  artifact: payload.path, bytes: stat.size, sha256, architecture,
  profile: isLockedArtifact ? 'locked production artifact' : 'development fixture',
  serveRoot: path.join(out, 'serve'),
  installedInto: targets,
}, null, 2));
