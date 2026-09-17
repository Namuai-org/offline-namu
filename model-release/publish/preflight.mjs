#!/usr/bin/env node
// Publication step (a): prove the local artifact is exactly the locked one.
//
//   node model-release/publish/preflight.mjs \
//     [--lock model-release/model.lock.json] \
//     [--artifact model-release/artifacts/tiny-aya-global-q4_k_m.gguf] \
//     [--allow-fixture]        staging only: accept a non-Aya fixture lock
//
// Checks: the lock is complete (MDL-003), the file's byte count equals
// lock.bytes, and its streaming SHA-256 equals lock.sha256. Reads the local
// file only; no network, no AWS.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {UPSTREAM_FILENAME, artifactKey, readLock, sha256File, sha256HexToBase64} from './lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_LOCK = path.join(root, 'model-release/model.lock.json');
export const DEFAULT_ARTIFACT = path.join(root, 'model-release/artifacts', UPSTREAM_FILENAME);

export async function preflight({lockFile = DEFAULT_LOCK, artifactFile = DEFAULT_ARTIFACT,
  allowFixture = false} = {}) {
  const lock = readLock(lockFile, {allowFixture});
  let stat;
  try {
    stat = fs.statSync(artifactFile);
  } catch {
    throw new Error(`artifact not found: ${artifactFile} (run model-release/acquire.py)`);
  }
  if (!stat.isFile()) {
    throw new Error(`artifact is not a regular file: ${artifactFile}`);
  }
  if (stat.size !== lock.bytes) {
    throw new Error(`artifact size ${stat.size} differs from lock.bytes ${lock.bytes}`);
  }
  const {sha256, bytes} = await sha256File(artifactFile);
  if (bytes !== lock.bytes || sha256 !== lock.sha256) {
    throw new Error(`artifact SHA-256 ${sha256} differs from lock.sha256 ${lock.sha256}`);
  }
  return {
    lock,
    artifactFile: path.resolve(artifactFile),
    key: artifactKey(lock),
    checksumSha256Base64: sha256HexToBase64(lock.sha256),
    fixture: allowFixture,
  };
}

async function main() {
  const {values: args} = parseArgs({
    options: {
      lock: {type: 'string', default: DEFAULT_LOCK},
      artifact: {type: 'string', default: DEFAULT_ARTIFACT},
      'allow-fixture': {type: 'boolean', default: false},
    },
  });
  const result = await preflight({
    lockFile: args.lock, artifactFile: args.artifact, allowFixture: args['allow-fixture'],
  });
  if (result.fixture) {
    console.error('WARNING: --allow-fixture: identity checks relaxed. Staging only; never production.');
  }
  console.log(JSON.stringify({
    ok: true,
    artifact: result.artifactFile,
    bytes: result.lock.bytes,
    sha256: result.lock.sha256,
    upstream_revision: result.lock.revision,
    object_key: result.key,
    s3_checksum_sha256_base64: result.checksumSha256Base64,
  }, null, 2));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`preflight failed: ${error.message}`);
    process.exit(1);
  });
}
