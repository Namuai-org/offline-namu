#!/usr/bin/env node
// MDL-006 desktop smoke test with the app's runtime family: llama.cpp at tag
// b10256 (the revision bundled by llama.rn 0.12.9, STK-002).
//
//   node model-release/desktop-smoke/run-smoke.mjs \
//     --llama-bin <llama.cpp>/build/bin \
//     [--model model-release/artifacts/tiny-aya-global-q4_k_m.gguf] \
//     [--lock model-release/model.lock.json] [--out model-release/desktop-smoke/out] \
//     [--port 8099] [--threads 4] [--gpu-layers 0]
//     [--committed-fixture model-release/runtime-fixture.json | none]
//
// NOT EXECUTED against llama.cpp or the real model in the authoring
// environment. smoke.test.mjs unit-tests the pure checks and runs this whole
// script against STUB llama-server/llama-tokenize programs only. See README.md.
//
// What it does: preflight the artifact against the lock; dump the runtime
// fixture from the GGUF metadata; start llama-server locally with the PRD
// section 9 configuration; record template renders and token counts
// (INF-002); confirm role/control markers tokenize to single special tokens
// (llama-tokenize); run Hausa/French/English single-turn, multi-turn and stop
// cases; write smoke-report.json, artifact-fixture.json, template-fixtures.json
// and outputs.md.
// Desktop success does not replace mobile testing.
import {execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {DEFAULT_ARTIFACT, DEFAULT_LOCK, preflight} from '../publish/preflight.mjs';
import {buildRuntimeFixture} from './gguf-metadata.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXPECTED_BUILD = '10256';

// PRD section 9 production configuration, test seed.
export const GENERATION = {
  max_tokens: 384, temperature: 0.3, top_p: 0.9, top_k: 40, repeat_penalty: 1.1, seed: 42, cache_prompt: false,
};

export function serverArgs({model, port, threads, gpuLayers}) {
  return [
    '-m', model, '--host', '127.0.0.1', '--port', String(port),
    '-c', '2048', '-n', '384', '-b', '256', '-ub', '128', '-t', String(threads),
    '-ngl', String(gpuLayers), '-np', '1', '-ctk', 'f16', '-ctv', 'f16',
    '--no-context-shift', '--jinja', '--no-webui', '--offline',
    '--seed', '42', '--temp', '0.3', '--top-p', '0.9', '--top-k', '40', '--repeat-penalty', '1.1',
  ];
}

export function systemPrompt(prompts) {
  return `${prompts.system.text}\n${prompts.system.response_language_line}`;
}

/** Control/role markers that leaked into visible text (INF-003). */
export function findLeaks(text, forbiddenMarkers) {
  return forbiddenMarkers.filter(marker => text.includes(marker));
}

/** Mechanical checks on one answer; language and quality are for human reviewers. */
export function answerProblems({text, finishReason, forbiddenMarkers, mustContain = [], expectFinish = null}) {
  const problems = [];
  if (typeof text !== 'string' || text.trim() === '') {
    problems.push('empty answer');
    return problems;
  }
  if (text.includes('\uFFFD')) {
    problems.push('replacement character in output (broken UTF-8 decoding)');
  }
  const leaks = findLeaks(text, forbiddenMarkers);
  if (leaks.length > 0) {
    problems.push(`control tokens leaked into visible output: ${leaks.join(' ')}`);
  }
  for (const needle of mustContain) {
    if (!text.toLowerCase().includes(needle.toLowerCase())) {
      problems.push(`expected the answer to contain "${needle}"`);
    }
  }
  if (expectFinish !== null && finishReason !== expectFinish) {
    problems.push(`finish_reason ${finishReason}, expected ${expectFinish}`);
  }
  return problems;
}

/** Control tokens that the chat template itself uses: the role/turn markers. */
export function templateMarkers(fixture) {
  const template = fixture.chat_template?.text ?? '';
  return fixture.control_tokens.filter(t => t.text.trim() !== '' && template.includes(t.text));
}

/**
 * model-release/runtime-fixture.json (written by inspect-header.mjs from the
 * upstream header, and compiled into the app) must describe the same template
 * and control tokens as the locked artifact that was actually downloaded.
 */
export function committedFixtureProblems(committed, fixture, lock) {
  const problems = [];
  if (committed.upstream_revision !== lock.revision) {
    problems.push(`runtime-fixture.json revision ${committed.upstream_revision} != lock revision ${lock.revision}`);
  }
  if (committed.chat_template_sha256 !== fixture.chat_template?.sha256) {
    problems.push('runtime-fixture.json chat_template_sha256 differs from the locked artifact');
  }
  const key = tokens => JSON.stringify((tokens ?? []).map(t => [t.id, t.text]).sort((a, b) => a[0] - b[0]));
  if (key(committed.control_tokens) !== key(fixture.control_tokens)) {
    problems.push('runtime-fixture.json control_tokens differ from the locked artifact');
  }
  for (const marker of committed.stop_markers ?? []) {
    if (!fixture.forbidden_output_markers.includes(marker)) {
      problems.push(`runtime-fixture.json stop marker ${marker} is not a control token of the locked artifact`);
    }
  }
  return problems;
}

/** Parses `llama-tokenize --ids` output such as "[5, 255000]". */
export function parseTokenizeIds(stdout) {
  const m = /\[([\d,\s]*)\]/.exec(stdout);
  if (!m) {
    throw new Error(`cannot parse llama-tokenize output: ${stdout.slice(0, 200)}`);
  }
  return m[1].split(',').map(s => s.trim()).filter(Boolean).map(Number);
}

export function renderOutputsMarkdown(report) {
  const lines = ['# Desktop smoke outputs (MDL-006)', '',
    `Runtime: ${report.runtime.build_info ?? 'unknown'}; artifact sha256 ${report.artifact.sha256}; ` +
    `prompt ${report.prompt_version}; seed ${GENERATION.seed}.`, '',
    'Read every answer. Hausa and French must be judged by fluent readers; the script only checks',
    'structure (non-empty, no control tokens, finish reason, multi-turn recall).', ''];
  for (const c of report.cases) {
    lines.push(`## ${c.id} (${c.language ?? 'n/a'}) — ${c.problems.length === 0 ? 'mechanical checks passed' : 'FAILED'}`, '');
    for (const p of c.problems) {
      lines.push(`- **${p}**`);
    }
    for (const turn of c.transcript) {
      lines.push('', `**${turn.role}:**`, '', turn.content);
    }
    lines.push('', `finish_reason: \`${c.finish_reason}\`, completion tokens: ${c.completion_tokens ?? 'n/a'}`, '');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Everything below talks to the llama.cpp binaries. It has only ever run
// against the stubs in smoke.test.mjs.
// ---------------------------------------------------------------------------

async function postJson(base, route, body, {signal} = {}) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal,
  });
  if (!res.ok) {
    throw new Error(`${route} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function waitForHealth(base, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`llama-server exited with code ${child.exitCode} while loading`);
    }
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('llama-server did not become healthy in time');
}

async function chat(base, messages, overrides = {}) {
  const body = await postJson(base, '/v1/chat/completions', {messages, stream: false, ...GENERATION, ...overrides});
  const choice = body.choices?.[0];
  return {
    text: choice?.message?.content ?? '',
    finishReason: choice?.finish_reason ?? null,
    completionTokens: body.usage?.completion_tokens ?? null,
    promptTokens: body.usage?.prompt_tokens ?? null,
  };
}

/** Starts a streamed answer, aborts it after a few chunks, then proves the server still answers. */
async function cancelCase(base, system, spec, forbiddenMarkers) {
  const controller = new AbortController();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, signal: controller.signal,
    body: JSON.stringify({messages: [{role: 'system', content: system}, {role: 'user', content: spec.user}],
      stream: true, ...GENERATION}),
  });
  let chunks = 0;
  let partial = '';
  let pending = '';
  try {
    const decoder = new TextDecoder();
    for await (const bytes of res.body) {
      pending += decoder.decode(bytes, {stream: true});
      const lines = pending.split('\n');
      pending = lines.pop(); // an event may be split across network chunks
      for (const line of lines) {
        if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
          partial += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? '';
          chunks += 1;
        }
      }
      if (chunks >= spec.abort_after_chunks) {
        controller.abort();
        break;
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      throw error;
    }
  }
  const started = Date.now();
  const after = await chat(base, [{role: 'user', content: 'Reply with the single word: ready'}], {max_tokens: 8});
  const problems = answerProblems({text: after.text, finishReason: after.finishReason, forbiddenMarkers});
  if (chunks < spec.abort_after_chunks) {
    problems.push(`stream ended after ${chunks} chunks, before the planned cancellation`);
  }
  return {
    id: 'stop-cancel', language: 'en', problems, finish_reason: 'cancelled-by-client',
    completion_tokens: null, recovery_ms: Date.now() - started,
    transcript: [{role: 'user', content: spec.user}, {role: 'assistant (partial, cancelled)', content: partial},
      {role: 'assistant (next request)', content: after.text}],
  };
}

async function main() {
  const {values: args} = parseArgs({
    options: {
      'llama-bin': {type: 'string', default: process.env.LLAMA_CPP_BIN},
      model: {type: 'string', default: DEFAULT_ARTIFACT},
      lock: {type: 'string', default: DEFAULT_LOCK},
      out: {type: 'string', default: path.join(here, 'out')},
      port: {type: 'string', default: '8099'},
      threads: {type: 'string', default: '4'},
      'gpu-layers': {type: 'string', default: '0'},
      'allow-other-build': {type: 'boolean', default: false},
      // The app's compiled-in fixture (inspect-header.mjs); "none" skips the comparison.
      'committed-fixture': {type: 'string', default: path.join(here, '../runtime-fixture.json')},
    },
  });
  if (!args['llama-bin']) {
    throw new Error('--llama-bin <llama.cpp build/bin directory> is required (or LLAMA_CPP_BIN)');
  }
  const serverBin = path.join(args['llama-bin'], 'llama-server');
  const tokenizeBin = path.join(args['llama-bin'], 'llama-tokenize');
  for (const bin of [serverBin, tokenizeBin]) {
    if (!fs.existsSync(bin)) {
      throw new Error(`${bin} not found; build llama.cpp b${EXPECTED_BUILD} first (see README.md)`);
    }
  }
  const prompts = JSON.parse(fs.readFileSync(path.join(here, 'prompts.json'), 'utf8'));
  const system = systemPrompt(prompts);
  fs.mkdirSync(args.out, {recursive: true});

  // 1. Only the locked artifact is ever parsed (DL-010 order: hash first).
  const pre = await preflight({lockFile: args.lock, artifactFile: args.model});
  console.log(`artifact ok: ${pre.lock.sha256}`);

  // 2. Runtime fixture from the model's own metadata.
  const fixture = buildRuntimeFixture(pre.artifactFile);
  fixture.source.sha256 = pre.lock.sha256;
  fs.writeFileSync(path.join(args.out, 'artifact-fixture.json'), JSON.stringify(fixture, null, 2) + '\n');
  if (fixture.chat_template === null) {
    throw new Error('the GGUF carries no tokenizer.chat_template; INF-002 cannot be satisfied');
  }
  const forbidden = fixture.forbidden_output_markers;
  const failures = [];
  const committedFixture = args['committed-fixture'];
  if (committedFixture !== 'none' && fs.existsSync(committedFixture)) {
    failures.push(...committedFixtureProblems(JSON.parse(fs.readFileSync(committedFixture, 'utf8')), fixture, pre.lock));
  }

  // 3. Role/turn markers must be single special tokens for this tokenizer.
  const markerChecks = templateMarkers(fixture).slice(0, 32).map(token => {
    const stdout = execFileSync(tokenizeBin, ['-m', pre.artifactFile, '-p', token.text, '--ids', '--no-bos',
      '--log-disable'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    const ids = parseTokenizeIds(stdout);
    const ok = ids.length === 1 && ids[0] === token.id;
    if (!ok) {
      failures.push(`marker ${token.text} tokenizes to [${ids}] instead of [${token.id}]`);
    }
    return {...token, tokenized_ids: ids, ok};
  });

  // 4. Server with the production configuration.
  const base = `http://127.0.0.1:${args.port}`;
  const log = fs.openSync(path.join(args.out, 'llama-server.log'), 'w');
  const child = spawn(serverBin, serverArgs({model: pre.artifactFile, port: args.port, threads: args.threads,
    gpuLayers: args['gpu-layers']}), {stdio: ['ignore', log, log]});
  const cases = [];
  let props = {};
  try {
    await waitForHealth(base, child, 300_000);
    props = await (await fetch(`${base}/props`)).json();
    if (!String(props.build_info ?? '').includes(EXPECTED_BUILD) && !args['allow-other-build']) {
      throw new Error(`llama-server build_info "${props.build_info}" is not b${EXPECTED_BUILD}`);
    }
    if (props.chat_template !== fixture.chat_template.text) {
      failures.push('llama-server chat_template differs from the GGUF metadata template');
    }

    // 5. Reference renders and token counts for the adapter tests (INF-002).
    const templateFixtures = [];
    for (const spec of prompts.template_fixtures) {
      const messages = spec.messages.map(m => ({...m, content: m.content === 'SYSTEM_PROMPT' ? system : m.content}));
      const {prompt} = await postJson(base, '/apply-template', {messages});
      const {tokens} = await postJson(base, '/tokenize', {content: prompt, add_special: false, parse_special: true,
        with_pieces: true});
      templateFixtures.push({id: spec.id, messages, rendered_prompt: prompt, token_count: tokens.length,
        token_ids: tokens.map(t => t.id)});
    }
    fs.writeFileSync(path.join(args.out, 'template-fixtures.json'), JSON.stringify({
      fixture_schema: 1, artifact_sha256: pre.lock.sha256, runtime_build: props.build_info ?? null,
      chat_template_sha256: fixture.chat_template.sha256, fixtures: templateFixtures,
    }, null, 2) + '\n');

    // 6. Three languages, single turn.
    for (const spec of prompts.single_turn) {
      const messages = [{role: 'system', content: system}, {role: 'user', content: spec.user}];
      const r = await chat(base, messages);
      cases.push({id: spec.id, language: spec.language, finish_reason: r.finishReason,
        completion_tokens: r.completionTokens, prompt_tokens: r.promptTokens,
        problems: answerProblems({text: r.text, finishReason: r.finishReason, forbiddenMarkers: forbidden}),
        transcript: [{role: 'user', content: spec.user}, {role: 'assistant', content: r.text}]});
    }

    // 7. Multi-turn formatting: the second answer must use the first turn.
    for (const spec of prompts.multi_turn) {
      const messages = [{role: 'system', content: system}];
      const transcript = [];
      let last = null;
      const problems = [];
      for (const [index, user] of spec.turns.entries()) {
        messages.push({role: 'user', content: user});
        last = await chat(base, messages);
        messages.push({role: 'assistant', content: last.text});
        transcript.push({role: 'user', content: user}, {role: 'assistant', content: last.text});
        problems.push(...answerProblems({text: last.text, finishReason: last.finishReason, forbiddenMarkers: forbidden,
          mustContain: index === spec.turns.length - 1 ? spec.final_answer_must_contain : []}));
      }
      cases.push({id: spec.id, language: spec.language, finish_reason: last.finishReason,
        completion_tokens: last.completionTokens, problems, transcript});
    }

    // 8. Stop behaviour: natural end, length limit, client cancellation.
    const natural = await chat(base, [{role: 'system', content: system}, {role: 'user', content: prompts.stop.natural_end.user}]);
    cases.push({id: 'stop-natural-end', language: 'en', finish_reason: natural.finishReason,
      completion_tokens: natural.completionTokens,
      problems: answerProblems({text: natural.text, finishReason: natural.finishReason, forbiddenMarkers: forbidden,
        expectFinish: 'stop'}),
      transcript: [{role: 'user', content: prompts.stop.natural_end.user}, {role: 'assistant', content: natural.text}]});
    const limited = await chat(base, [{role: 'system', content: system}, {role: 'user', content: prompts.stop.length_limit.user}],
      {max_tokens: prompts.stop.length_limit.max_tokens});
    cases.push({id: 'stop-length-limit', language: 'en', finish_reason: limited.finishReason,
      completion_tokens: limited.completionTokens,
      problems: answerProblems({text: limited.text, finishReason: limited.finishReason, forbiddenMarkers: forbidden,
        expectFinish: 'length'}),
      transcript: [{role: 'user', content: prompts.stop.length_limit.user}, {role: 'assistant', content: limited.text}]});
    cases.push(await cancelCase(base, system, prompts.stop.cancel, forbidden));
  } finally {
    child.kill('SIGTERM');
    fs.closeSync(log);
  }

  for (const c of cases) {
    failures.push(...c.problems.map(p => `${c.id}: ${p}`));
  }
  const report = {
    report_schema: 1, requirement: 'MDL-006', generated_at: new Date().toISOString(),
    artifact: {sha256: pre.lock.sha256, bytes: pre.lock.bytes, upstream_revision: pre.lock.revision},
    runtime: {build_info: props.build_info ?? null, expected_build: `b${EXPECTED_BUILD}`,
      server_args: serverArgs({model: '<artifact>', port: args.port, threads: args.threads, gpuLayers: args['gpu-layers']})},
    prompt_version: prompts.system.prompt_version, generation: GENERATION,
    chat_template_sha256: fixture.chat_template.sha256, marker_checks: markerChecks, cases,
    mechanical_failures: failures,
    human_review_required: 'Hausa and French outputs must be read by fluent reviewers; this report is not a quality result.',
  };
  fs.writeFileSync(path.join(args.out, 'smoke-report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(args.out, 'outputs.md'), renderOutputsMarkdown(report) + '\n');
  console.log(`report: ${path.join(args.out, 'smoke-report.json')}; read ${path.join(args.out, 'outputs.md')}`);
  if (failures.length > 0) {
    console.error(`mechanical failures (${failures.length}):\n  - ${failures.join('\n  - ')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`smoke test aborted: ${error.message}`);
    process.exit(2);
  });
}
