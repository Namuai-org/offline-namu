// node:test suite for the desktop smoke tooling. Real llama.cpp and the real
// model are never used here: the GGUF is synthesized and, for the end-to-end
// case, llama-server/llama-tokenize are replaced by small stub programs. That
// proves the orchestration and the checks, not the runtime.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, {after, before, describe} from 'node:test';
import {fileURLToPath} from 'node:url';
import {TYPE, buildFixtureGguf, kv, str, u32, u64} from '../dev/make-fixture-gguf.mjs';
import {GgufMetadataError, buildRuntimeFixture, readGgufMetadata} from './gguf-metadata.mjs';
import {
  GENERATION,
  answerProblems,
  committedFixtureProblems,
  findLeaks,
  parseTokenizeIds,
  renderOutputsMarkdown,
  serverArgs,
  systemPrompt,
  templateMarkers,
} from './run-smoke.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const prompts = JSON.parse(fs.readFileSync(path.join(here, 'prompts.json'), 'utf8'));

const TOKENS = ['<PAD>', '<BOS>', '<EOS>', '<|START_TURN|>', '<|END_TURN|>', '<|USER|>', '<|BOT|>', 'hello', 'ƙ', '<0x0A>'];
const TOKEN_TYPES = [3, 3, 3, 3, 3, 3, 3, 1, 1, 6];
const TEMPLATE = "{% for m in messages %}<|START_TURN|>{{ '<|USER|>' if m.role == 'user' else '<|BOT|>' }}{{ m.content }}<|END_TURN|>{% endfor %}<|START_TURN|><|BOT|>";

function i32(value) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(value);
  return b;
}

function tokenizerGguf() {
  return buildFixtureGguf({
    architecture: 'cohere2',
    payloadBytes: 2048,
    extraEntries: [
      kv('cohere2.context_length', TYPE.u32, u32(8192)),
      kv('tokenizer.ggml.model', TYPE.string, str('gpt2')),
      kv('tokenizer.ggml.tokens', TYPE.array, Buffer.concat([u32(TYPE.string), u64(TOKENS.length), ...TOKENS.map(str)])),
      kv('tokenizer.ggml.token_type', TYPE.array, Buffer.concat([u32(TYPE.i32), u64(TOKEN_TYPES.length), ...TOKEN_TYPES.map(i32)])),
      kv('tokenizer.ggml.merges', TYPE.array, Buffer.concat([u32(TYPE.string), u64(2), str('h e'), str('l l')])),
      kv('tokenizer.ggml.bos_token_id', TYPE.u32, u32(1)),
      kv('tokenizer.ggml.eos_token_id', TYPE.u32, u32(2)),
      kv('tokenizer.ggml.padding_token_id', TYPE.u32, u32(0)),
      kv('tokenizer.ggml.add_bos_token', 7, Buffer.from([1])),
      kv('tokenizer.chat_template', TYPE.string, str(TEMPLATE)),
    ],
  });
}

function freePort() {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const {port} = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

describe('desktop smoke tooling', () => {
  let tmp;
  let modelFile;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'namu-smoke-'));
    modelFile = path.join(tmp, 'tokenizer-fixture.gguf');
    fs.writeFileSync(modelFile, tokenizerGguf());
  });

  after(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  test('runtime fixture is derived from the GGUF metadata', () => {
    const fixture = buildRuntimeFixture(modelFile, {hash: true});
    assert.equal(fixture.general.architecture, 'cohere2');
    assert.equal(fixture.model.context_length, 8192);
    assert.equal(fixture.tokenizer.vocab_size, TOKENS.length);
    assert.equal(fixture.tokenizer.add_bos_token, true);
    assert.deepEqual(fixture.special_tokens.eos, {id: 2, text: '<EOS>'});
    assert.deepEqual(fixture.special_tokens.bos, {id: 1, text: '<BOS>'});
    assert.deepEqual(fixture.special_tokens.padding, {id: 0, text: '<PAD>'});
    assert.deepEqual(fixture.control_tokens.map(t => t.id), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(fixture.forbidden_output_markers, TOKENS.slice(0, 7));
    assert.equal(fixture.chat_template.text, TEMPLATE);
    assert.equal(fixture.chat_template.sha256, crypto.createHash('sha256').update(TEMPLATE).digest('hex'));
    assert.equal(fixture.source.sha256, crypto.createHash('sha256').update(fs.readFileSync(modelFile)).digest('hex'));
    // Role markers = control tokens that the template actually uses.
    assert.deepEqual(templateMarkers(fixture).map(t => t.text), ['<|START_TURN|>', '<|END_TURN|>', '<|USER|>', '<|BOT|>']);
  });

  test('metadata reader skips arrays it was not asked to keep and rejects malformed input', () => {
    const meta = readGgufMetadata(modelFile);
    assert.equal(meta.values.has('tokenizer.ggml.merges'), false);
    assert.deepEqual(meta.arrays.get('tokenizer.ggml.merges'), {type: TYPE.string, count: 2});
    assert.equal(meta.values.get('tokenizer.ggml.tokens')[8], 'ƙ');

    const bytes = fs.readFileSync(modelFile);
    const bad = (name, mutate, pattern) => {
      const copy = Buffer.from(bytes);
      const out = mutate(copy) ?? copy;
      const file = path.join(tmp, `${name}.gguf`);
      fs.writeFileSync(file, out);
      assert.throws(() => readGgufMetadata(file), error => error instanceof GgufMetadataError && pattern.test(error.message), name);
    };
    bad('magic', b => void b.write('NOPE', 0, 'latin1'), /bad magic/);
    bad('version', b => void b.writeUInt32LE(9, 4), /unsupported version/);
    bad('kv-count', b => void b.writeBigUInt64LE(5000n, 16), /counts out of bounds/);
    bad('truncated', b => b.subarray(0, 120), /past the end/);
    bad('huge-string', b => void b.writeBigUInt64LE(1n << 40n, 24), /string too long/);
    const noTemplate = path.join(tmp, 'no-template.gguf');
    fs.writeFileSync(noTemplate, buildFixtureGguf({architecture: 'llama'}));
    assert.equal(buildRuntimeFixture(noTemplate).chat_template, null);
  });

  test('answer checks: leaks, recall, finish reason, broken UTF-8', () => {
    const markers = ['<|END_TURN|>', '<|BOT|>'];
    assert.deepEqual(findLeaks('fine', markers), []);
    assert.deepEqual(findLeaks('text<|END_TURN|>', markers), ['<|END_TURN|>']);
    assert.deepEqual(answerProblems({text: 'Millet.', finishReason: 'stop', forbiddenMarkers: markers,
      mustContain: ['millet'], expectFinish: 'stop'}), []);
    assert.deepEqual(answerProblems({text: '   ', finishReason: 'stop', forbiddenMarkers: markers}), ['empty answer']);
    assert.match(answerProblems({text: 'Rice<|BOT|>', finishReason: 'stop', forbiddenMarkers: markers})[0], /leaked/);
    assert.match(answerProblems({text: 'Rice', finishReason: 'stop', forbiddenMarkers: markers, mustContain: ['millet']})[0], /millet/);
    assert.match(answerProblems({text: 'x', finishReason: 'length', forbiddenMarkers: markers, expectFinish: 'stop'})[0], /finish_reason/);
    assert.match(answerProblems({text: 'caf\uFFFD', finishReason: 'stop', forbiddenMarkers: markers})[0], /UTF-8/);
    assert.deepEqual(parseTokenizeIds('[255001]\n'), [255001]);
    assert.deepEqual(parseTokenizeIds('[ 5, 17 ]'), [5, 17]);
    assert.deepEqual(parseTokenizeIds('[]'), []);
    assert.throws(() => parseTokenizeIds('error: no model'), /cannot parse/);
  });

  test('committed runtime-fixture.json must agree with the locked artifact', () => {
    const fixture = buildRuntimeFixture(modelFile);
    const lock = {revision: 'a'.repeat(40)};
    const committed = {
      upstream_revision: lock.revision, chat_template_sha256: fixture.chat_template.sha256,
      control_tokens: [...fixture.control_tokens].reverse(), stop_markers: ['<|END_TURN|>'],
    };
    assert.deepEqual(committedFixtureProblems(committed, fixture, lock), []);
    assert.match(committedFixtureProblems({...committed, upstream_revision: 'b'.repeat(40)}, fixture, lock)[0], /revision/);
    assert.match(committedFixtureProblems({...committed, chat_template_sha256: '0'.repeat(64)}, fixture, lock)[0], /chat_template/);
    assert.match(committedFixtureProblems({...committed, control_tokens: committed.control_tokens.slice(1)}, fixture, lock)[0], /control_tokens/);
    assert.match(committedFixtureProblems({...committed, stop_markers: ['</s>']}, fixture, lock)[0], /stop marker/);
  });

  test('server arguments and sampling carry the PRD section 9 configuration', () => {
    const args = serverArgs({model: 'm.gguf', port: 1, threads: 4, gpuLayers: 0});
    const value = flag => args[args.indexOf(flag) + 1];
    assert.equal(value('-c'), '2048');
    assert.equal(value('-n'), '384');
    assert.equal(value('-b'), '256');
    assert.equal(value('-ub'), '128');
    assert.equal(value('-np'), '1');
    assert.equal(value('-ctk'), 'f16');
    assert.equal(value('-ctv'), 'f16');
    assert.equal(value('--host'), '127.0.0.1');
    for (const flag of ['--no-context-shift', '--offline', '--no-webui', '--jinja']) {
      assert.ok(args.includes(flag), flag);
    }
    assert.deepEqual(GENERATION, {max_tokens: 384, temperature: 0.3, top_p: 0.9, top_k: 40, repeat_penalty: 1.1,
      seed: 42, cache_prompt: false});
  });

  test('prompts cover three languages, multi-turn and stop, and use the bundled system prompt', t => {
    for (const language of ['ha', 'fr', 'en']) {
      assert.ok(prompts.single_turn.some(p => p.language === language), `single-turn ${language}`);
      assert.ok(prompts.multi_turn.some(p => p.language === language), `multi-turn ${language}`);
    }
    assert.ok(prompts.multi_turn.every(p => p.turns.length >= 2 && p.final_answer_must_contain.length > 0));
    assert.deepEqual(Object.keys(prompts.stop).sort(), ['cancel', 'length_limit', 'natural_end']);
    assert.deepEqual(prompts.template_fixtures.map(f => f.id), ['first-turn', 'system-message', 'multi-turn', 'multilingual']);
    assert.ok(prompts.single_turn.some(p => /[ƙɗɓ]/.test(p.user)), 'Hausa hooked letters are exercised (LOC-002)');
    assert.ok(systemPrompt(prompts).endsWith('\nResponse language: match the latest user message.'));

    // Drift alarm: the smoke test must talk to the model with the app's own system text.
    const source = path.join(root, 'src/domain/chat/systemPrompt.ts');
    if (!fs.existsSync(source)) {
      t.diagnostic('src/domain/chat/systemPrompt.ts not present; drift check skipped');
      return;
    }
    const literals = [...fs.readFileSync(source, 'utf8').matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)]
      .map(m => (m[1] ?? m[2]).replace(/\\(['"])/g, '$1')).join('');
    assert.ok(literals.includes(prompts.system.text), 'prompts.json system text differs from systemPrompt.ts');
    assert.ok(literals.includes(prompts.system.response_language_line));
    assert.ok(literals.includes(prompts.system.prompt_version));
  });

  test('outputs.md lists every case and its failures', () => {
    const md = renderOutputsMarkdown({
      runtime: {build_info: 'b10256-test'}, artifact: {sha256: 'a'.repeat(64)}, prompt_version: 'namu-text-2',
      cases: [
        {id: 'ha-explain', language: 'ha', problems: [], finish_reason: 'stop', completion_tokens: 12,
          transcript: [{role: 'user', content: 'Tambaya'}, {role: 'assistant', content: 'Amsa'}]},
        {id: 'stop-length-limit', language: 'en', problems: ['finish_reason stop, expected length'],
          finish_reason: 'stop', completion_tokens: 3, transcript: []},
      ],
    });
    assert.match(md, /## ha-explain \(ha\) — mechanical checks passed/);
    assert.match(md, /## stop-length-limit \(en\) — FAILED/);
    assert.match(md, /\*\*finish_reason stop, expected length\*\*/);
    assert.match(md, /Amsa/);
  });

  test('run-smoke.mjs end to end against STUB llama-server and llama-tokenize', async () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const tokenIds = Object.fromEntries(TOKENS.map((text, id) => [text, id]));
    fs.writeFileSync(path.join(bin, 'llama-tokenize'), `#!${process.execPath}
const ids = ${JSON.stringify(tokenIds)};
const text = process.argv[process.argv.indexOf('-p') + 1];
console.log('[' + (text in ids ? ids[text] : '7, 7') + ']');
`, {mode: 0o755});
    fs.writeFileSync(path.join(bin, 'llama-server'), `#!${process.execPath}
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const template = ${JSON.stringify(TEMPLATE)};
const send = (res, body) => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body)); };
http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/health') return send(res, {status: 'ok'});
    if (req.url === '/props') return send(res, {build_info: 'b10256-stub', chat_template: template});
    if (req.url === '/apply-template') return send(res, {prompt: body.messages.map(m => '<|START_TURN|>' + m.content + '<|END_TURN|>').join('')});
    if (req.url === '/tokenize') return send(res, {tokens: body.content.split(/\\s+/).filter(Boolean).map((piece, id) => ({id, piece}))});
    if (req.url === '/v1/chat/completions') {
      if (body.stream) {
        res.writeHead(200, {'Content-Type': 'text/event-stream'});
        let n = 0;
        const timer = setInterval(() => {
          n += 1;
          res.write('data: ' + JSON.stringify({choices: [{delta: {content: n + '\\n'}}]}) + '\\n\\n');
        }, 5);
        res.on('close', () => clearInterval(timer));
        return;
      }
      const transcript = body.messages.map(m => m.content).join(' ');
      const last = body.messages.at(-1).content;
      const recall = ['millet', 'Niamey', 'Zinder'].find(w => transcript.includes(w) && /one word|un mot|kalma/.test(last));
      const limited = body.max_tokens === 16;
      return send(res, {choices: [{message: {content: recall ?? (limited ? 'Agriculture began' : 'A stub answer.')},
        finish_reason: limited ? 'length' : 'stop'}], usage: {completion_tokens: limited ? 16 : 4, prompt_tokens: 20}});
    }
    res.writeHead(404); res.end();
  });
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`, {mode: 0o755});

    const bytes = fs.readFileSync(modelFile);
    const lockFile = path.join(tmp, 'model.lock.json');
    fs.writeFileSync(lockFile, JSON.stringify({
      schema: 1, repo_id: 'CohereLabs/tiny-aya-global-GGUF', revision: '0'.repeat(40),
      filename: 'tiny-aya-global-q4_k_m.gguf', bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), architecture: 'cohere2', quantization: 'Q4_K_M',
    }));
    const out = path.join(tmp, 'out');
    const port = await freePort();
    const result = await new Promise(resolve => {
      execFile(process.execPath, [path.join(here, 'run-smoke.mjs'), '--llama-bin', bin, '--model', modelFile,
        '--lock', lockFile, '--out', out, '--port', String(port), '--committed-fixture', 'none'], {encoding: 'utf8'},
      (error, stdout, stderr) => resolve({status: error ? error.code : 0, stdout, stderr}));
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const report = JSON.parse(fs.readFileSync(path.join(out, 'smoke-report.json'), 'utf8'));
    assert.deepEqual(report.mechanical_failures, []);
    assert.equal(report.runtime.build_info, 'b10256-stub');
    assert.equal(report.marker_checks.length, 4);
    assert.ok(report.marker_checks.every(m => m.ok));
    const ids = report.cases.map(c => c.id);
    for (const id of ['ha-explain', 'fr-explain', 'en-explain', 'en-memory', 'fr-memory', 'ha-memory',
      'stop-natural-end', 'stop-length-limit', 'stop-cancel']) {
      assert.ok(ids.includes(id), id);
    }
    assert.equal(report.cases.find(c => c.id === 'stop-length-limit').finish_reason, 'length');
    assert.match(report.cases.find(c => c.id === 'stop-cancel').transcript[1].content, /^1\n2\n/);

    const templates = JSON.parse(fs.readFileSync(path.join(out, 'template-fixtures.json'), 'utf8'));
    assert.equal(templates.fixtures.length, 4);
    assert.ok(templates.fixtures[1].rendered_prompt.includes('your name is Namu'));
    assert.ok(fs.existsSync(path.join(out, 'artifact-fixture.json')));
    assert.match(fs.readFileSync(path.join(out, 'outputs.md'), 'utf8'), /## ha-memory \(ha\) — mechanical checks passed/);
  });
});
