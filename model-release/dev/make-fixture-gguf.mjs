#!/usr/bin/env node
// Development/CI tool: fabricate a tiny, structurally valid GGUF v3 file.
//
//   node model-release/dev/make-fixture-gguf.mjs --out /tmp/fixture.gguf
//        [--architecture llama] [--payload-bytes 262144]
//
// The file has a correct header and metadata section (including
// general.architecture) and zero tensors, followed by deterministic filler
// bytes. It exercises descriptor signing, transfer, hashing and the structural
// GGUF check (native-contract.md section 6.4 step 3). It is NOT a loadable
// model: inference tests need a real redistributable fixture model, and
// release qualification needs the locked Aya artifact (REL-001).
import crypto from 'node:crypto';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

export const TYPE = {u32: 4, i32: 5, f32: 6, bool: 7, string: 8, array: 9, u64: 10};
const ALIGNMENT = 32;

export function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
}

export function u64(value) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

export function str(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u64(bytes.length), bytes]);
}

export function kv(key, type, valueBytes) {
  return Buffer.concat([str(key), u32(type), valueBytes]);
}

/** Deterministic filler so the same arguments always give the same SHA-256. */
function filler(length) {
  const blocks = [];
  let block = crypto.createHash('sha256').update('namu-fixture-gguf').digest();
  for (let produced = 0; produced < length; produced += block.length) {
    blocks.push(block);
    block = crypto.createHash('sha256').update(block).digest();
  }
  return Buffer.concat(blocks).subarray(0, length);
}

/** extraEntries: additional pre-encoded key/value pairs (see kv()), e.g. tokenizer metadata for tests. */
export function buildFixtureGguf({architecture = 'llama', payloadBytes = 0, version = 3, extraEntries = []} = {}) {
  const f32 = Buffer.alloc(4);
  f32.writeFloatLE(0.5);
  // general.architecture is deliberately not first, so readers must skip
  // scalars, a string and arrays (of scalars and of strings) to reach it.
  const entries = [
    kv('general.alignment', TYPE.u32, u32(ALIGNMENT)),
    kv('general.name', TYPE.string, str('namu-structural-fixture')),
    kv('fixture.scalars', TYPE.array, Buffer.concat([u32(TYPE.u32), u64(3), u32(1), u32(2), u32(3)])),
    kv('fixture.tokens', TYPE.array, Buffer.concat([u32(TYPE.string), u64(2), str('<a>'), str('<b>')])),
    kv('fixture.flag', TYPE.bool, Buffer.from([1])),
    kv('fixture.scale', TYPE.f32, f32),
    kv('fixture.count', TYPE.u64, u64(7)),
    kv('general.architecture', TYPE.string, str(architecture)),
    ...extraEntries,
  ];
  const header = Buffer.concat([
    Buffer.from('GGUF', 'latin1'), u32(version), u64(0), u64(entries.length), ...entries,
  ]);
  const padding = Buffer.alloc((ALIGNMENT - (header.length % ALIGNMENT)) % ALIGNMENT);
  return Buffer.concat([header, padding, filler(payloadBytes)]);
}

function main() {
  const {values: args} = parseArgs({
    options: {
      out: {type: 'string'},
      architecture: {type: 'string', default: 'llama'},
      'payload-bytes': {type: 'string', default: '262144'},
    },
  });
  if (!args.out) {
    throw new Error('--out <file.gguf> is required');
  }
  const payloadBytes = Number(args['payload-bytes']);
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0 || payloadBytes > 1024 ** 3) {
    throw new Error('--payload-bytes must be an integer from 0 to 1 GiB');
  }
  const bytes = buildFixtureGguf({architecture: args.architecture, payloadBytes});
  fs.writeFileSync(args.out, bytes);
  console.log(JSON.stringify({
    file: args.out,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    architecture: args.architecture,
    loadable: false,
  }, null, 2));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
