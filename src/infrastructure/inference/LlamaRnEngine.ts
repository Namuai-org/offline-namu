/**
 * The ONLY module that imports llama.rn (ARC-001, PRD section 4).
 * Written against the pinned package's installed types (0.12.9, llama.cpp
 * b10256). Mapping of every PRD section 9 setting to the pinned API is
 * documented in docs/engineering/runtime-contract.md (INF-001).
 */
import {BuildInfo, initLlama, type LlamaContext, type TokenData} from 'llama.rn';
import type {
  ChatMessage,
  EngineState,
  GenerateRequest,
  GenerateResult,
  NamuEngine,
  SelfTestResult,
  TextEvent,
} from '../../domain/inference/InferenceEngine';
import {InferenceFailure, UnsupportedRuntimeFailure} from '../../domain/inference/failures';
import {
  SELF_TEST_OUTPUT_TOKENS,
  TEST_SAMPLING,
  type ResolvedInferenceParameters,
} from '../../domain/inference/productionConfig';
import {RUNTIME_FIXTURE} from './runtimeFixture';
import {SELF_TEST_MESSAGES} from './selfTestFixture';
import {findControlToken, neutralizeControlTokens, safeEmitLength} from './controlTokens';

export const EXPECTED_LLAMA_CPP_BUILD = '10256';

export interface LlamaRnEngineDeps {
  platform: 'android' | 'ios';
  parameters: ResolvedInferenceParameters;
  /** Native store lookup; the adapter never builds paths itself. */
  resolveArtifactPath: (artifactId: string) => Promise<string>;
  /** DL-013 live runtime reference. */
  setRuntimeReference: (artifactId: string | null) => void;
  /** Internal simulator builds only: allow a CPU context on iOS (DEV-001). */
  allowCpuOnIosSimulator: boolean;
  diagnostics: {record(code: string, fields?: Record<string, number | string | boolean | null | undefined>): void};
}

interface Formatted {
  key: string;
  prompt: string;
  chatFormat: number | undefined;
  generationPrompt: string | undefined;
  additionalStops: string[];
  tokenCount: number;
}

export class LlamaRnEngine implements NamuEngine {
  private context: LlamaContext | null = null;
  private artifactId: string | null = null;
  private engineState: EngineState = 'unloaded';
  private lastFormatted: Formatted | null = null;
  private activeRequestId: string | null = null;
  private cancelRequested = false;
  private generationDone: Promise<void> | null = null;

  constructor(private readonly deps: LlamaRnEngineDeps) {}

  state(): EngineState {
    return this.engineState;
  }

  loadedArtifactId(): string | null {
    return this.artifactId;
  }

  async load(artifactId: string): Promise<void> {
    if (this.context) {
      throw new InferenceFailure('MODEL_LOAD_FAILED', 'context-already-loaded');
    }
    if (BuildInfo.number !== EXPECTED_LLAMA_CPP_BUILD) {
      // STK-002: the bundled llama.cpp revision is part of the runtime build ID.
      throw new InferenceFailure('MODEL_INCOMPATIBLE', `runtime-build-${BuildInfo.number}`);
    }
    const p = this.deps.parameters;
    this.engineState = 'loading';
    try {
      const path = await this.deps.resolveArtifactPath(artifactId);
      const context = await initLlama({
        model: path,
        n_ctx: p.nCtx,
        n_batch: p.batch,
        n_ubatch: p.ubatch,
        n_threads: p.threads,
        n_gpu_layers: p.gpuLayers,
        n_parallel: p.parallel,
        cache_type_k: p.cacheTypeK as 'f16',
        cache_type_v: p.cacheTypeV as 'f16',
        use_mmap: p.mmap,
        use_mlock: p.mlock,
        ctx_shift: p.ctxShift,
        embedding: false,
        speculative: false,
      });
      if (this.deps.platform === 'ios' && !context.gpu && !this.deps.allowCpuOnIosSimulator) {
        // DEV-004: zero silent CPU fallback on iOS.
        await context.release().catch(() => undefined);
        throw new UnsupportedRuntimeFailure('metal-unavailable');
      }
      if (this.deps.platform === 'android' && context.gpu) {
        await context.release().catch(() => undefined);
        throw new InferenceFailure('MODEL_LOAD_FAILED', 'unexpected-gpu-backend');
      }
      this.context = context;
      this.artifactId = artifactId;
      this.lastFormatted = null;
      this.deps.setRuntimeReference(artifactId);
      // INF-001: record the requested configuration and what the runtime reported.
      this.deps.diagnostics.record('engine.config', {
        runtimeBuildId: p.runtimeBuildId,
        contextTokens: p.nCtx,
        batch: p.batch,
        ubatch: p.ubatch,
        threads: p.threads,
        gpuLayers: p.gpuLayers,
        gpu: context.gpu,
        mode: context.gpu ? 'metal' : 'cpu',
      });
      this.engineState = 'ready';
    } catch (error) {
      this.engineState = 'error';
      if (error instanceof InferenceFailure) {
        throw error;
      }
      throw new InferenceFailure(looksLikeMemoryFailure(error) ? 'MEMORY_LOW' : 'MODEL_LOAD_FAILED', 'init-failed');
    }
  }

  /**
   * INF-002: roles are formatted by the GGUF's embedded template through the
   * runtime; nothing is hand-concatenated. The count is for exactly the string
   * that `generate` will submit: the formatted result is cached by message
   * content and reused.
   */
  async countFormattedTokens(messages: ChatMessage[]): Promise<number> {
    return (await this.format(messages)).tokenCount;
  }

  private async format(messages: ChatMessage[]): Promise<Formatted> {
    const context = this.requireContext();
    const safe = messages.map(m => ({
      role: m.role,
      // Role/control markers typed or pasted by a user must stay plain text.
      content: m.role === 'user' ? neutralizeControlTokens(m.content) : m.content,
    }));
    const key = JSON.stringify(safe);
    if (this.lastFormatted?.key === key) {
      return this.lastFormatted;
    }
    const result = await context.getFormattedChat(safe, null, {
      jinja: true,
      add_generation_prompt: true,
      enable_thinking: false,
      reasoning_format: 'none',
    });
    if (result.type !== 'jinja') {
      throw new InferenceFailure('MODEL_INCOMPATIBLE', 'embedded-template-not-used');
    }
    const jinja = result as typeof result & {
      chat_format?: number;
      generation_prompt?: string;
      additional_stops?: string[];
    };
    const tokenized = await context.tokenize(jinja.prompt);
    // The runtime strips the template's leading BOS text and the completion
    // path adds one BOS token when the vocabulary requests it (add_bos_token).
    const tokenCount = tokenized.tokens.length + (RUNTIME_FIXTURE.addBosToken ? 1 : 0);
    const formatted: Formatted = {
      key,
      prompt: jinja.prompt,
      chatFormat: jinja.chat_format,
      generationPrompt: jinja.generation_prompt,
      additionalStops: jinja.additional_stops ?? [],
      tokenCount,
    };
    this.lastFormatted = formatted;
    return formatted;
  }

  /** INF-004: clear native KV/session state; weights stay loaded. */
  async resetSession(): Promise<void> {
    await this.requireContext().clearCache(true);
  }

  async generate(request: GenerateRequest, onText: (event: TextEvent) => void): Promise<GenerateResult> {
    const context = this.requireContext();
    if (this.engineState !== 'ready') {
      throw new InferenceFailure('MODEL_LOAD_FAILED', `generate-in-${this.engineState}`);
    }
    const p = this.deps.parameters;
    const formatted = await this.format(request.messages);
    return this.complete(context, request.id, formatted, onText, {
      n_predict: p.nPredict,
      temperature: p.temperature,
      top_p: p.topP,
      top_k: p.topK,
      penalty_repeat: p.repeatPenalty,
      seed: p.seed,
    });
  }

  private async complete(
    context: LlamaContext,
    requestId: string,
    formatted: Formatted,
    onText: (event: TextEvent) => void,
    sampling: {n_predict: number; temperature: number; top_p: number; top_k: number; penalty_repeat: number; seed: number},
  ): Promise<GenerateResult> {
    this.engineState = 'generating';
    this.activeRequestId = requestId;
    this.cancelRequested = false;
    let finish!: () => void;
    this.generationDone = new Promise<void>(resolve => {
      finish = resolve;
    });

    let raw = '';
    let emittedLength = 0;
    let sequence = 0;
    let leaked = false;
    const emitSafePrefix = (final: boolean) => {
      if (leaked) {
        return;
      }
      const hit = findControlToken(raw, emittedLength);
      let limit: number;
      if (hit !== -1) {
        // INF-003: a control token must never become visible output.
        leaked = true;
        limit = hit;
      } else {
        limit = final ? raw.length : safeEmitLength(raw);
      }
      if (limit > emittedLength) {
        const delta = raw.slice(emittedLength, limit);
        emittedLength = limit;
        onText({requestId, sequence: sequence++, delta});
      }
    };

    try {
      const result = await context.completion(
        {
          prompt: formatted.prompt,
          chat_format: formatted.chatFormat,
          generation_prompt: formatted.generationPrompt,
          jinja: true,
          enable_thinking: false,
          reasoning_format: 'none',
          n_threads: this.deps.parameters.threads,
          stop: [...RUNTIME_FIXTURE.stopMarkers, ...formatted.additionalStops],
          ignore_eos: false,
          n_probs: 0,
          ...sampling,
        },
        (data: TokenData) => {
          // The native layer emits complete UTF-8 pieces (INF-005); the
          // adapter re-sequences them after the control-token guard.
          if (this.activeRequestId !== requestId || typeof data.token !== 'string') {
            return;
          }
          raw += data.token;
          emitSafePrefix(false);
        },
      );
      const finalText = cutAtControlToken(typeof result.text === 'string' && result.text.length > 0 ? result.text : raw);
      raw = finalText.length >= emittedLength ? finalText : raw;
      emitSafePrefix(true);
      const text = raw.slice(0, emittedLength);

      if (result.tokens_evaluated !== formatted.tokenCount && result.tokens_cached === 0) {
        this.deps.diagnostics.record('prompt.count.mismatch', {
          countedTokens: formatted.tokenCount,
          evaluatedTokens: result.tokens_evaluated,
        });
      }
      let reason: GenerateResult['reason'];
      if (this.cancelRequested || result.interrupted) {
        reason = 'cancelled';
      } else if (result.stopped_eos || (result.stopped_word ?? '').length > 0 || leaked) {
        reason = 'eos';
      } else if (result.stopped_limit > 0 || result.context_full || result.truncated) {
        reason = 'length';
      } else {
        reason = 'eos';
      }
      return {
        requestId,
        text,
        reason,
        promptTokens: result.tokens_evaluated,
        outputTokens: result.tokens_predicted,
        timings: {
          prefillMs: result.timings?.prompt_ms,
          decodeMs: result.timings?.predicted_ms,
          tokensPerSecond: result.timings?.predicted_per_second,
        },
      };
    } catch (error) {
      if (this.cancelRequested) {
        return {requestId, text: raw.slice(0, emittedLength), reason: 'cancelled'};
      }
      throw new InferenceFailure(looksLikeMemoryFailure(error) ? 'MEMORY_LOW' : 'ANSWER_INTERRUPTED', 'completion-failed');
    } finally {
      this.activeRequestId = null;
      this.engineState = this.context ? 'ready' : 'unloaded';
      finish();
    }
  }

  /**
   * INF-006: uses the native stop mechanism and resolves only after the
   * running completion has returned (the acknowledgement). Never queued behind
   * the generation it stops.
   */
  async cancel(requestId: string): Promise<void> {
    if (this.activeRequestId !== requestId || !this.context) {
      return;
    }
    this.cancelRequested = true;
    this.engineState = 'stopping';
    await this.context.stopCompletion();
    await this.generationDone;
  }

  async unload(): Promise<void> {
    if (this.engineState === 'generating' || this.engineState === 'stopping') {
      // Never free a running context (INF-006).
      throw new InferenceFailure('CANCEL_TIMEOUT', 'unload-while-generating');
    }
    const context = this.context;
    this.context = null;
    this.artifactId = null;
    this.lastFormatted = null;
    if (context) {
      await context.release();
    }
    this.deps.setRuntimeReference(null);
    this.engineState = 'unloaded';
  }

  /**
   * DL-011: production context, fixed fixture prompt, 32 deterministic tokens.
   * Uses no user content. Passes on a valid non-empty result with no leaked
   * control tokens.
   */
  async runSelfTest(): Promise<SelfTestResult> {
    const context = this.requireContext();
    await context.clearCache(true);
    const formatted = await this.format(SELF_TEST_MESSAGES);
    try {
      const result = await this.complete(
        context,
        'self-test',
        formatted,
        () => undefined,
        {
          n_predict: SELF_TEST_OUTPUT_TOKENS,
          temperature: TEST_SAMPLING.temperature,
          top_p: TEST_SAMPLING.topP,
          top_k: TEST_SAMPLING.topK,
          penalty_repeat: TEST_SAMPLING.repeatPenalty,
          seed: TEST_SAMPLING.seed,
        },
      );
      await context.clearCache(true);
      const text = result.text.trim();
      const valid = text.length > 0 && findControlToken(result.text, 0) === -1 && !text.includes(String.fromCharCode(0xfffd));
      return {
        passed: valid && (result.outputTokens ?? 0) > 0,
        failureCode: valid ? null : 'MODEL_LOAD_FAILED',
        promptTokens: formatted.tokenCount,
        outputTokens: result.outputTokens ?? 0,
      };
    } catch {
      return {passed: false, failureCode: 'MODEL_LOAD_FAILED', promptTokens: formatted.tokenCount, outputTokens: 0};
    }
  }

  private requireContext(): LlamaContext {
    if (!this.context) {
      throw new InferenceFailure('MODEL_LOAD_FAILED', 'not-loaded');
    }
    return this.context;
  }
}

function cutAtControlToken(text: string): string {
  const at = findControlToken(text, 0);
  return at === -1 ? text : text.slice(0, at);
}

function looksLikeMemoryFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /alloc|out of memory|insufficient memory|failed to allocate/i.test(message);
}
