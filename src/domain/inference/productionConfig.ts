/**
 * Production inference configuration (PRD section 9 table). These are product
 * decisions; there are no user-facing tuning controls (PRD-002, S06).
 */
export const RUNTIME_BUILD_ID = 'llamarn-0.12.9-b10256';

export const CONTEXT_TOKENS = 2048;
export const MAX_OUTPUT_TOKENS = 384;
/** 2048 − 384 − 32 safety margin. */
export const PROMPT_CEILING_TOKENS = 1632;
export const SAFETY_MARGIN_TOKENS = CONTEXT_TOKENS - MAX_OUTPUT_TOKENS - PROMPT_CEILING_TOKENS;

export const SAMPLING = {
  temperature: 0.3,
  topP: 0.9,
  topK: 40,
  repeatPenalty: 1.1,
  /** Runtime random seed in production. */
  seed: -1,
} as const;

/** Deterministic sampler for tests and the DL-011 self-test. */
export const TEST_SAMPLING = {
  temperature: 0,
  topP: 1,
  topK: 1,
  repeatPenalty: 1,
  seed: 42,
} as const;

export const BATCH_TOKENS = 256;
export const MICRO_BATCH_TOKENS = 128;
export const KV_CACHE_TYPE = 'f16' as const;
export const USE_MMAP = true;
export const USE_MLOCK = false;
export const PARALLEL_REQUESTS = 1;
export const MAX_CPU_THREADS = 4;

export const SELF_TEST_OUTPUT_TOKENS = 32;
export const SELF_TEST_PROMPT_TOKENS = 128;

/** INF-006 */
export const CANCEL_ACK_TIMEOUT_MS = 5000;
/** INF-007 */
export const IDLE_UNLOAD_MS = 120_000;
/** INF-008 */
export const THERMAL_RECOVERY_MS = 30_000;

export function cpuThreads(logicalCpuCount: number): number {
  return Math.max(1, Math.min(MAX_CPU_THREADS, Math.floor(logicalCpuCount)));
}

export function gpuLayers(platform: 'android' | 'ios'): number {
  // DEV-004: Android is CPU only; iOS requests full Metal offload.
  return platform === 'ios' ? 99 : 0;
}

export interface ResolvedInferenceParameters {
  runtimeBuildId: string;
  nCtx: number;
  nPredict: number;
  promptCeiling: number;
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  seed: number;
  threads: number;
  batch: number;
  ubatch: number;
  cacheTypeK: string;
  cacheTypeV: string;
  mmap: boolean;
  mlock: boolean;
  gpuLayers: number;
  parallel: number;
  ctxShift: false;
}

/** Stored with every generation (`generations.parameters_json`). */
export function resolveParameters(platform: 'android' | 'ios', logicalCpuCount: number): ResolvedInferenceParameters {
  return {
    runtimeBuildId: RUNTIME_BUILD_ID,
    nCtx: CONTEXT_TOKENS,
    nPredict: MAX_OUTPUT_TOKENS,
    promptCeiling: PROMPT_CEILING_TOKENS,
    temperature: SAMPLING.temperature,
    topP: SAMPLING.topP,
    topK: SAMPLING.topK,
    repeatPenalty: SAMPLING.repeatPenalty,
    seed: SAMPLING.seed,
    threads: cpuThreads(logicalCpuCount),
    batch: BATCH_TOKENS,
    ubatch: MICRO_BATCH_TOKENS,
    cacheTypeK: KV_CACHE_TYPE,
    cacheTypeV: KV_CACHE_TYPE,
    mmap: USE_MMAP,
    mlock: USE_MLOCK,
    gpuLayers: gpuLayers(platform),
    parallel: PARALLEL_REQUESTS,
    ctxShift: false,
  };
}
