#!/usr/bin/env node
// Dumps the runtime fixture from a GGUF's own metadata (INF-002, INF-003,
// MDL-006): the embedded chat template, the special token ids and texts, and
// every CONTROL token, which are the strings that must never appear in
// visible output. Dependency-free, bounded, reads metadata only.
//
//   node model-release/desktop-smoke/gguf-metadata.mjs \
//     --model model-release/artifacts/tiny-aya-global-q4_k_m.gguf \
//     --out model-release/desktop-smoke/out/artifact-fixture.json
//
// Stop markers are DERIVED from the locked model here; nobody copies a generic
// Llama/Qwen stop list (INF-003). Run it only on a file that passed
// publish/preflight.mjs (the hash gate comes first, DL-010).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const MAX_KV = 4096;
const MAX_TENSORS = 65536;
const MAX_STRING = 4 * 1024 * 1024;
const MAX_ARRAY = 1 << 24;
const WINDOW = 8 * 1024 * 1024;
const TOKEN_TYPE = {1: 'normal', 2: 'unknown', 3: 'control', 4: 'user_defined', 5: 'unused', 6: 'byte'};

export class GgufMetadataError extends Error {}

/** Forward-only reader over a file with a sliding window. */
class Cursor {
  constructor(fd, size) {
    this.fd = fd;
    this.size = size;
    this.pos = 0;
    this.buffer = Buffer.alloc(0);
    this.bufferStart = 0;
  }

  take(n) {
    if (n < 0 || this.pos + n > this.size) {
      throw new GgufMetadataError('metadata runs past the end of the file');
    }
    if (this.pos < this.bufferStart || this.pos + n > this.bufferStart + this.buffer.length) {
      const length = Math.min(Math.max(n, WINDOW), this.size - this.pos);
      this.buffer = Buffer.alloc(length);
      fs.readSync(this.fd, this.buffer, 0, length, this.pos);
      this.bufferStart = this.pos;
    }
    const offset = this.pos - this.bufferStart;
    this.pos += n;
    return this.buffer.subarray(offset, offset + n);
  }

  u32() {
    return this.take(4).readUInt32LE(0);
  }

  u64() {
    const v = this.take(8).readBigUInt64LE(0);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new GgufMetadataError('length out of range');
    }
    return Number(v);
  }

  string() {
    const length = this.u64();
    if (length > MAX_STRING) {
      throw new GgufMetadataError('string too long');
    }
    return this.take(length).toString('utf8');
  }

  scalar(type) {
    switch (type) {
      case 0: return this.take(1).readUInt8(0);
      case 1: return this.take(1).readInt8(0);
      case 2: return this.take(2).readUInt16LE(0);
      case 3: return this.take(2).readInt16LE(0);
      case 4: return this.take(4).readUInt32LE(0);
      case 5: return this.take(4).readInt32LE(0);
      case 6: return this.take(4).readFloatLE(0);
      case 7: return this.take(1).readUInt8(0) !== 0;
      case 8: return this.string();
      case 10: return Number(this.take(8).readBigUInt64LE(0));
      case 11: return Number(this.take(8).readBigInt64LE(0));
      case 12: return this.take(8).readDoubleLE(0);
      default: throw new GgufMetadataError(`unknown value type ${type}`);
    }
  }
}

/**
 * @returns {{version: number, tensorCount: number, values: Map<string, unknown>, arrays: Map<string, {type: number, count: number}>}}
 * Arrays are materialized only for the keys in `keepArrays`; others are skipped.
 */
export function readGgufMetadata(file, {keepArrays = ['tokenizer.ggml.tokens', 'tokenizer.ggml.token_type']} = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const cursor = new Cursor(fd, fs.fstatSync(fd).size);
    if (cursor.take(4).toString('latin1') !== 'GGUF') {
      throw new GgufMetadataError('bad magic');
    }
    const version = cursor.u32();
    if (version !== 2 && version !== 3) {
      throw new GgufMetadataError(`unsupported version ${version}`);
    }
    const tensorCount = cursor.u64();
    const kvCount = cursor.u64();
    if (tensorCount > MAX_TENSORS || kvCount > MAX_KV) {
      throw new GgufMetadataError('counts out of bounds');
    }
    const values = new Map();
    const arrays = new Map();
    for (let i = 0; i < kvCount; i++) {
      const key = cursor.string();
      const type = cursor.u32();
      if (type !== 9) {
        values.set(key, cursor.scalar(type));
        continue;
      }
      const inner = cursor.u32();
      const count = cursor.u64();
      if (inner === 9 || count > MAX_ARRAY) {
        throw new GgufMetadataError('nested or oversized array');
      }
      arrays.set(key, {type: inner, count});
      const keep = keepArrays.includes(key);
      const items = keep ? new Array(count) : null;
      for (let j = 0; j < count; j++) {
        const item = cursor.scalar(inner);
        if (keep) {
          items[j] = item;
        }
      }
      if (keep) {
        values.set(key, items);
      }
    }
    return {version, tensorCount, values, arrays};
  } finally {
    fs.closeSync(fd);
  }
}

export function buildRuntimeFixture(file, {hash = false} = {}) {
  const {version, tensorCount, values, arrays} = readGgufMetadata(file);
  const architecture = values.get('general.architecture');
  if (typeof architecture !== 'string') {
    throw new GgufMetadataError('general.architecture missing');
  }
  const tokens = values.get('tokenizer.ggml.tokens') ?? null;
  const types = values.get('tokenizer.ggml.token_type') ?? null;
  const describe = id => (Number.isInteger(id) && tokens && id >= 0 && id < tokens.length
    ? {id, text: tokens[id]}
    : id === undefined ? null : {id, text: null});

  const special = {};
  for (const [key, value] of values) {
    const m = /^tokenizer\.ggml\.([a-z_]+)_token_id$/.exec(key);
    if (m) {
      special[m[1]] = describe(value);
    }
  }
  const byType = name => (tokens && types
    ? types.flatMap((t, id) => (TOKEN_TYPE[t] === name ? [{id, text: tokens[id]}] : []))
    : []);
  const control = byType('control');
  const template = values.get('tokenizer.chat_template');

  const general = {};
  const model = {};
  for (const [key, value] of values) {
    if (Array.isArray(value)) {
      continue;
    }
    if (key.startsWith('general.')) {
      general[key.slice('general.'.length)] = value;
    } else if (key.startsWith(`${architecture}.`)) {
      model[key.slice(architecture.length + 1)] = value;
    }
  }

  const fixture = {
    fixture_schema: 1,
    source: {
      file: path.basename(file),
      bytes: fs.statSync(file).size,
      sha256: null,
      gguf_version: version,
      tensor_count: tensorCount,
    },
    general,
    model,
    tokenizer: {
      model: values.get('tokenizer.ggml.model') ?? null,
      pre: values.get('tokenizer.ggml.pre') ?? null,
      vocab_size: tokens ? tokens.length : arrays.get('tokenizer.ggml.tokens')?.count ?? null,
      add_bos_token: values.get('tokenizer.ggml.add_bos_token') ?? null,
      add_eos_token: values.get('tokenizer.ggml.add_eos_token') ?? null,
    },
    special_tokens: special,
    control_tokens: control,
    user_defined_tokens: byType('user_defined'),
    // INF-003: text that must never reach the user. Empty strings cannot be searched for.
    forbidden_output_markers: [...new Set(control.map(t => t.text).filter(text => text.trim() !== ''))],
    chat_template: typeof template === 'string'
      ? {sha256: crypto.createHash('sha256').update(template, 'utf8').digest('hex'), text: template}
      : null,
  };
  if (hash) {
    const digest = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(WINDOW);
      for (let read; (read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
        digest.update(buffer.subarray(0, read));
      }
    } finally {
      fs.closeSync(fd);
    }
    fixture.source.sha256 = digest.digest('hex');
  }
  return fixture;
}

function main() {
  const {values: args} = parseArgs({
    options: {
      model: {type: 'string'},
      out: {type: 'string'},
      hash: {type: 'boolean', default: false},
    },
  });
  if (!args.model) {
    throw new Error('--model <file.gguf> is required');
  }
  const fixture = buildRuntimeFixture(args.model, {hash: args.hash});
  const json = JSON.stringify(fixture, null, 2) + '\n';
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), {recursive: true});
    fs.writeFileSync(args.out, json);
    console.log(`artifact fixture written: ${args.out}`);
    console.log(`  architecture ${fixture.general.architecture}, vocab ${fixture.tokenizer.vocab_size}, ` +
      `${fixture.control_tokens.length} control tokens, chat template ${fixture.chat_template ? fixture.chat_template.sha256 : 'ABSENT'}`);
  } else {
    process.stdout.write(json);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
