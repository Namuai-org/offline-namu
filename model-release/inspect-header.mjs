#!/usr/bin/env node
// Release tool (INF-002, INF-003): derive the runtime fixture — chat template,
// special token IDs and the control-token list — from the GGUF metadata of the
// exact upstream revision, without downloading tensor data.
//
//   node model-release/inspect-header.mjs --revision <40-hex> [--file local.gguf]
//
// Remote mode reads only the leading metadata bytes through HTTP range
// requests. Output: model-release/runtime-fixture.json and the generated
// src/infrastructure/inference/runtimeFixture.ts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const REPO = 'CohereLabs/tiny-aya-global-GGUF';
const FILENAME = 'tiny-aya-global-q4_k_m.gguf';
const CHUNK = 8 * 1024 * 1024;
const MAX_HEADER = 256 * 1024 * 1024;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const {values: args} = parseArgs({
  options: {revision: {type: 'string'}, file: {type: 'string'}},
});
if (!args.file && !/^[0-9a-f]{40}$/.test(args.revision ?? '')) {
  throw new Error('--revision <full 40-hex upstream commit> is required (no floating main)');
}

class NeedMore extends Error {}

/** Growable byte source backed by range requests or a local file. */
class Source {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }
  async grow() {
    if (this.buffer.length >= MAX_HEADER) {
      throw new Error('metadata larger than expected; refusing to continue');
    }
    const start = this.buffer.length;
    const end = start + CHUNK - 1;
    let chunk;
    if (args.file) {
      const fd = fs.openSync(args.file, 'r');
      chunk = Buffer.alloc(CHUNK);
      const read = fs.readSync(fd, chunk, 0, CHUNK, start);
      fs.closeSync(fd);
      chunk = chunk.subarray(0, read);
    } else {
      const url = `https://huggingface.co/${REPO}/resolve/${args.revision}/${FILENAME}`;
      const response = await fetch(url, {headers: {Range: `bytes=${start}-${end}`}});
      if (response.status !== 206) {
        throw new Error(`expected 206 for a range request, got ${response.status}`);
      }
      chunk = Buffer.from(await response.arrayBuffer());
    }
    if (chunk.length === 0) {
      throw new Error('unexpected end of file inside metadata');
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }
}

const SCALAR = {
  0: [1, (b, o) => b.readUInt8(o)], 1: [1, (b, o) => b.readInt8(o)],
  2: [2, (b, o) => b.readUInt16LE(o)], 3: [2, (b, o) => b.readInt16LE(o)],
  4: [4, (b, o) => b.readUInt32LE(o)], 5: [4, (b, o) => b.readInt32LE(o)],
  6: [4, (b, o) => b.readFloatLE(o)], 7: [1, (b, o) => b.readUInt8(o) !== 0],
  10: [8, (b, o) => Number(b.readBigUInt64LE(o))], 11: [8, (b, o) => Number(b.readBigInt64LE(o))],
  12: [8, (b, o) => b.readDoubleLE(o)],
};

function parse(buffer) {
  let o = 0;
  const need = n => {
    if (o + n > buffer.length) {
      throw new NeedMore();
    }
  };
  const u32 = () => { need(4); const v = buffer.readUInt32LE(o); o += 4; return v; };
  const u64 = () => { need(8); const v = Number(buffer.readBigUInt64LE(o)); o += 8; return v; };
  const str = () => { const n = u64(); need(n); const s = buffer.toString('utf8', o, o + n); o += n; return s; };
  const value = type => {
    if (type in SCALAR) {
      const [size, read] = SCALAR[type];
      need(size);
      const v = read(buffer, o);
      o += size;
      return v;
    }
    if (type === 8) {
      return str();
    }
    if (type === 9) {
      const inner = u32();
      const count = u64();
      const out = new Array(count);
      for (let i = 0; i < count; i++) {
        out[i] = value(inner);
      }
      return out;
    }
    throw new Error(`unknown GGUF value type ${type}`);
  };

  need(4);
  if (buffer.toString('latin1', 0, 4) !== 'GGUF') {
    throw new Error('not a GGUF file');
  }
  o = 4;
  const version = u32();
  const tensorCount = u64();
  const kvCount = u64();
  const kv = new Map();
  for (let i = 0; i < kvCount; i++) {
    const key = str();
    const type = u32();
    kv.set(key, value(type));
  }
  return {version, tensorCount, kv, metadataBytes: o};
}

const source = new Source();
let parsed;
for (;;) {
  await source.grow();
  try {
    parsed = parse(source.buffer);
    break;
  } catch (e) {
    if (!(e instanceof NeedMore)) {
      throw e;
    }
  }
}

const {kv} = parsed;
const tokens = kv.get('tokenizer.ggml.tokens') ?? [];
const types = kv.get('tokenizer.ggml.token_type') ?? [];
// llama.cpp token types: 3 = CONTROL, 4 = USER_DEFINED.
const control = [];
for (let i = 0; i < tokens.length; i++) {
  if (types[i] === 3) {
    control.push({id: i, text: tokens[i]});
  }
}
const template = kv.get('tokenizer.chat_template') ?? '';
const idOf = key => (kv.has(key) ? kv.get(key) : null);
const textOf = id => (id === null || id === undefined ? null : tokens[id] ?? null);

// INF-003: stop markers are DERIVED from the locked template, never copied from
// another model family. The assistant branch renders
//   <role markers>{{ message['content'] }}<closing markers>
// followed by the per-turn terminator; the closing markers and the terminator
// are what ends an assistant response.
function deriveStopMarkers(tmpl, controlSet) {
  const branch = /role == 'assistant'[^%]*%\}([^{]*)\{\{ message\['content'\] \}\}([^{]*)\{%/.exec(tmpl);
  const terminator = /\{% endif %\}((?:<\|[A-Z_]+\|>)+)\{% endfor %\}/.exec(tmpl);
  const split = text => (text.match(/<\|[A-Z_]+\|>|<[A-Z_]+>/g) ?? []);
  const markers = [...split(branch?.[2] ?? ''), ...split(terminator?.[1] ?? '')];
  if (markers.length === 0) {
    throw new Error('could not derive stop markers from the chat template');
  }
  for (const marker of markers) {
    if (!controlSet.has(marker)) {
      throw new Error(`derived stop marker ${marker} is not a control token of this vocabulary`);
    }
  }
  return [...new Set(markers)];
}
const stopMarkers = deriveStopMarkers(template, new Set(control.map(c => c.text)));
const generationPrefix = /\{% if add_generation_prompt %\}([^{]*)\{% endif %\}/.exec(template)?.[1] ?? null;

const fixture = {
  schema: 1,
  upstream_repo: REPO,
  upstream_filename: FILENAME,
  upstream_revision: args.revision ?? 'local-file',
  gguf_version: parsed.version,
  tensor_count: parsed.tensorCount,
  metadata_bytes: parsed.metadataBytes,
  architecture: kv.get('general.architecture'),
  model_name: kv.get('general.name') ?? null,
  context_length: kv.get(`${kv.get('general.architecture')}.context_length`) ?? null,
  tokenizer_model: kv.get('tokenizer.ggml.model') ?? null,
  tokenizer_pre: kv.get('tokenizer.ggml.pre') ?? null,
  vocab_size: tokens.length,
  add_bos_token: kv.get('tokenizer.ggml.add_bos_token') ?? null,
  add_eos_token: kv.get('tokenizer.ggml.add_eos_token') ?? null,
  bos: {id: idOf('tokenizer.ggml.bos_token_id'), text: textOf(idOf('tokenizer.ggml.bos_token_id'))},
  eos: {id: idOf('tokenizer.ggml.eos_token_id'), text: textOf(idOf('tokenizer.ggml.eos_token_id'))},
  eot: {id: idOf('tokenizer.ggml.eot_token_id'), text: textOf(idOf('tokenizer.ggml.eot_token_id'))},
  pad: {id: idOf('tokenizer.ggml.padding_token_id'), text: textOf(idOf('tokenizer.ggml.padding_token_id'))},
  chat_template_sha256: crypto.createHash('sha256').update(template).digest('hex'),
  chat_template: template,
  stop_markers: stopMarkers,
  generation_prefix: generationPrefix,
  control_tokens: control,
  other_metadata_keys: [...kv.keys()].filter(k => !k.startsWith('tokenizer.ggml.')).sort(),
};

fs.writeFileSync(path.join(here, 'runtime-fixture.json'), JSON.stringify(fixture, null, 2) + '\n');

const controlTexts = control.map(c => c.text).filter(t => typeof t === 'string' && t.length > 0);
const ts = `// GENERATED by model-release/inspect-header.mjs — do not edit by hand.
// Derived from ${REPO}@${fixture.upstream_revision} (${FILENAME}) GGUF metadata (INF-003).
export const RUNTIME_FIXTURE = {
  upstreamRevision: ${JSON.stringify(fixture.upstream_revision)},
  architecture: ${JSON.stringify(fixture.architecture)},
  chatTemplateSha256: ${JSON.stringify(fixture.chat_template_sha256)},
  addBosToken: ${JSON.stringify(fixture.add_bos_token)},
  bosText: ${JSON.stringify(fixture.bos.text)},
  eosText: ${JSON.stringify(fixture.eos.text)},
  eotText: ${JSON.stringify(fixture.eot.text)},
  /** Derived from the locked template's assistant turn; see inspect-header.mjs. */
  stopMarkers: ${JSON.stringify(stopMarkers)} as readonly string[],
  generationPrefix: ${JSON.stringify(generationPrefix)},
  /** Every CONTROL-type token of the locked tokenizer; none may reach visible output. */
  controlTokens: ${JSON.stringify(controlTexts, null, 2).replace(/\n/g, '\n  ')} as readonly string[],
} as const;
`;
fs.writeFileSync(path.join(root, 'src/infrastructure/inference/runtimeFixture.ts'), ts);
console.log(JSON.stringify({
  fetchedBytes: source.buffer.length, metadataBytes: parsed.metadataBytes,
  architecture: fixture.architecture, vocab: tokens.length, controlTokens: control.length,
  bos: fixture.bos, eos: fixture.eos, eot: fixture.eot, addBos: fixture.add_bos_token,
  templateSha256: fixture.chat_template_sha256, stopMarkers, generationPrefix,
}, null, 2));
