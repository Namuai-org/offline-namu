import type {NamuEngine} from '../../src/domain/inference/InferenceEngine';
import {PROMPT_CEILING_TOKENS, type ResolvedInferenceParameters} from '../../src/domain/inference/productionConfig';
import {gate, median, percentile, type GateResult} from './stats';
import {
  MIXED_AND_EMOJI,
  mediumPrompt,
  nearBudgetSeed,
  shortPrompt,
  twentyTurnScript,
  type Workload,
  type WorkloadLanguage,
} from './workloads';

/**
 * Real-device benchmark harness (PRD sections 18–19). It drives the same
 * NamuEngine adapter the product uses, in a RELEASE build on a physical
 * device. Results from simulators or debug JS execution are not performance
 * evidence (OBS-003) — the harness refuses to label them as such.
 *
 * These numbers are end-to-end app timings. Kernel prefill/decode metrics come
 * from llama-bench separately (OBS-002, D17).
 */
export interface BenchmarkIdentity {
  deviceModel: string;
  osName: string;
  osVersion: string;
  availableMemoryBytes: number;
  runtimeBuildId: string;
  artifactSha256: string;
  appBuild: number;
  parameters: ResolvedInferenceParameters;
  charging: 'charging' | 'unplugged' | 'unknown';
  thermalStateAtStart: string;
  fixtureHash: string;
  isSimulator: boolean;
  isDebugBuild: boolean;
}

export interface Sample {
  workload: string;
  promptTokens: number;
  outputTokens: number;
  firstTokenMs: number;
  totalMs: number;
  decodeTokensPerSecond: number;
  reason: string;
}

export interface BenchmarkReport {
  schema: 1;
  startedAt: string;
  identity: BenchmarkIdentity;
  evidenceGrade: 'device-release' | 'not-evidence';
  loadsMs: number[];
  samples: Sample[];
  stopAckMs: number[];
  sustained: {firstMinuteTps: number; finalMinuteTps: number; ratio: number} | null;
  gates: GateResult[];
  notes: string[];
}

export interface HarnessDeps {
  engine: NamuEngine;
  artifactId: string;
  identity: BenchmarkIdentity;
  now: () => number;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
}

async function runOnce(deps: HarnessDeps, workload: Workload, id: string): Promise<Sample> {
  const {engine, now} = deps;
  await engine.resetSession();
  const promptTokens = await engine.countFormattedTokens(workload.messages);
  const start = now();
  let first = -1;
  const result = await engine.generate({id, conversationId: 'benchmark', messages: workload.messages}, () => {
    if (first < 0) {
      first = now() - start; // boundary: generate() call → first visible text
    }
  });
  const total = now() - start;
  const outputTokens = result.outputTokens ?? 0;
  const decodeMs = result.timings?.decodeMs ?? Math.max(1, total - Math.max(0, first));
  return {
    workload: workload.id,
    promptTokens: result.promptTokens ?? promptTokens,
    outputTokens,
    firstTokenMs: first < 0 ? total : first,
    totalMs: total,
    decodeTokensPerSecond: result.timings?.tokensPerSecond ?? (outputTokens / decodeMs) * 1000,
    reason: result.reason,
  };
}

export async function runBenchmarks(
  deps: HarnessDeps,
  options: {firstTokenSamples?: number; shortSamples?: number; coldLoads?: number; sustainedMinutes?: number; loadCycles?: number} = {},
): Promise<BenchmarkReport> {
  const {engine, identity, log, now, sleep} = deps;
  const firstTokenSamples = options.firstTokenSamples ?? 30; // QA-002 / NFR-002
  const shortSamples = options.shortSamples ?? 10;
  const coldLoads = options.coldLoads ?? 20; // NFR-003
  const sustainedMinutes = options.sustainedMinutes ?? 15; // NFR-009
  const loadCycles = options.loadCycles ?? 50; // NFR-008
  const report: BenchmarkReport = {
    schema: 1,
    startedAt: new Date().toISOString(),
    identity,
    evidenceGrade: identity.isSimulator || identity.isDebugBuild ? 'not-evidence' : 'device-release',
    loadsMs: [],
    samples: [],
    stopAckMs: [],
    sustained: null,
    gates: [],
    notes: [],
  };
  if (report.evidenceGrade === 'not-evidence') {
    report.notes.push('Simulator or debug build: results are NOT performance evidence (OBS-003).');
  }

  // NFR-003 cold model load
  for (let i = 0; i < coldLoads; i++) {
    if (engine.loadedArtifactId() !== null) {
      await engine.unload();
    }
    const start = now();
    await engine.load(deps.artifactId);
    report.loadsMs.push(now() - start);
    log(`load ${i + 1}/${coldLoads}: ${report.loadsMs[i]} ms`);
  }

  // One warm-up (discarded by design, declared here), then samples.
  await runOnce(deps, shortPrompt('en'), 'warmup');
  const languages: WorkloadLanguage[] = ['ha', 'fr', 'en'];
  for (const language of languages) {
    for (let i = 0; i < firstTokenSamples; i++) {
      report.samples.push(await runOnce(deps, shortPrompt(language), `short-${language}-${i}`));
    }
    for (let i = 0; i < shortSamples; i++) {
      report.samples.push(await runOnce(deps, mediumPrompt(language), `medium-${language}-${i}`));
    }
    // Near-budget prompt grown with the engine's own count.
    const seed = nearBudgetSeed(language);
    let body = seed.prefix + seed.unit;
    for (;;) {
      const next = body + seed.unit;
      const tokens = await engine.countFormattedTokens([seed.system, {role: 'user', content: next}]);
      if (tokens > PROMPT_CEILING_TOKENS) {
        break;
      }
      body = next;
    }
    report.samples.push(
      await runOnce(deps, {id: `near-budget-${language}`, language, messages: [seed.system, {role: 'user', content: body}]}, `near-${language}`),
    );
    // 20-turn chat
    const script = twentyTurnScript(language);
    const messages = [seed.system];
    for (let turn = 0; turn < script.length; turn++) {
      messages.push({role: 'user', content: script[turn]!});
      await engine.resetSession();
      if ((await engine.countFormattedTokens(messages)) > PROMPT_CEILING_TOKENS) {
        messages.splice(1, 2); // drop the oldest pair, like the product does
      }
      const result = await engine.generate({id: `chat-${language}-${turn}`, conversationId: 'benchmark', messages}, () => undefined);
      messages.push({role: 'assistant', content: result.text.length > 0 ? result.text : '…'});
    }
    log(`language ${language} done`);
  }
  report.samples.push(await runOnce(deps, MIXED_AND_EMOJI, 'mixed'));

  // NFR-005 stop acknowledgement during prefill and decode
  for (const delay of [0, 50, 400, 1500]) {
    await engine.resetSession();
    const id = `stop-${delay}`;
    const running = engine.generate({id, conversationId: 'benchmark', messages: mediumPrompt('en').messages}, () => undefined);
    await sleep(delay);
    const start = now();
    await engine.cancel(id);
    report.stopAckMs.push(now() - start);
    await running.catch(() => undefined);
  }

  // NFR-009 sustained throughput
  if (sustainedMinutes > 0) {
    const perMinute: number[] = [];
    const end = now() + sustainedMinutes * 60_000;
    let minuteStart = now();
    let tokens = 0;
    let i = 0;
    while (now() < end) {
      const sample = await runOnce(deps, shortPrompt(languages[i % 3]!), `sustained-${i++}`);
      tokens += sample.outputTokens;
      if (now() - minuteStart >= 60_000) {
        perMinute.push(tokens / ((now() - minuteStart) / 1000));
        minuteStart = now();
        tokens = 0;
      }
    }
    if (perMinute.length >= 2) {
      const firstMinuteTps = perMinute[0]!;
      const finalMinuteTps = perMinute[perMinute.length - 1]!;
      report.sustained = {firstMinuteTps, finalMinuteTps, ratio: finalMinuteTps / firstMinuteTps};
    }
  }

  // NFR-008 load / generate / stop / unload cycles (memory is sampled natively)
  for (let i = 0; i < loadCycles; i++) {
    await engine.unload();
    await engine.load(deps.artifactId);
    const id = `cycle-${i}`;
    const running = engine.generate({id, conversationId: 'benchmark', messages: shortPrompt('en').messages}, () => undefined);
    await sleep(300);
    await engine.cancel(id);
    await running.catch(() => undefined);
  }
  await engine.unload();

  const short = report.samples.filter(s => s.workload.startsWith('short-'));
  const decode = short.map(s => s.decodeTokensPerSecond).filter(Number.isFinite);
  report.gates = [
    gate('NFR-002', 'Warm first token P95 ≤ 6 s', percentile(short.map(s => s.firstTokenMs), 95), '<=', 6000, short.length),
    gate('NFR-003', 'Cold model load P95 ≤ 12 s', percentile(report.loadsMs, 95), '<=', 12000, report.loadsMs.length),
    gate('NFR-004a', 'Median decode ≥ 5 tokens/s', median(decode), '>=', 5, decode.length),
    gate('NFR-004b', 'P10 decode ≥ 3 tokens/s', percentile(decode, 10), '>=', 3, decode.length),
    gate('NFR-005', 'Native stop P95 ≤ 1 s', percentile(report.stopAckMs, 95), '<=', 1000, report.stopAckMs.length),
    gate('NFR-009', 'Final-minute throughput ≥ 70 % of first minute', report.sustained?.ratio ?? Number.NaN, '>=', 0.7, report.sustained ? 1 : 0),
  ];
  return report;
}
