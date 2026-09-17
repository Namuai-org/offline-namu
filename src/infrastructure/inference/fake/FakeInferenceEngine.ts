import type {
  ChatMessage,
  EngineState,
  GenerateRequest,
  GenerateResult,
  NamuEngine,
  SelfTestResult,
  TextEvent,
} from '../../../domain/inference/InferenceEngine';
import {InferenceFailure} from '../../../domain/inference/failures';
import {MAX_OUTPUT_TOKENS} from '../../../domain/inference/productionConfig';
import {codePointLength} from '../../../domain/text/graphemes';

/**
 * Scriptable stand-in for the model (QA-004). Used by unit/UI tests and by
 * internal simulator builds for functional journeys (DEV-001). It is never
 * selectable in production UI and never ships as a second model (REL-001).
 */
export interface FakeEngineScript {
  loadDelayMs: number;
  failLoadWith: InferenceFailure | null;
  /** Tokens streamed for the next generation. */
  tokens: string[];
  tokenDelayMs: number;
  /** Finish reason when every token was emitted. */
  finishReason: 'eos' | 'length';
  failGenerationWith: InferenceFailure | null;
  /** INF-006 test hook: the native stop is never acknowledged. */
  neverAcknowledgeCancel: boolean;
  selfTestPasses: boolean;
}

const DEFAULT_TOKENS = ['This ', 'is ', 'a ', '**fake** ', 'answer ', 'for ', 'functional ', 'tests.'];

export function approximateTokens(messages: ChatMessage[]): number {
  // Deterministic and monotonic in content length, like a real tokenizer.
  let total = 3;
  for (const m of messages) {
    total += 4 + Math.ceil(codePointLength(m.content) / 4);
  }
  return total;
}

export class FakeInferenceEngine implements NamuEngine {
  script: FakeEngineScript = {
    loadDelayMs: 0,
    failLoadWith: null,
    tokens: DEFAULT_TOKENS,
    tokenDelayMs: 0,
    finishReason: 'eos',
    failGenerationWith: null,
    neverAcknowledgeCancel: false,
    selfTestPasses: true,
  };

  /** Observability for tests. */
  readonly prompts: ChatMessage[][] = [];
  readonly events: string[] = [];
  loadCount = 0;
  resetCount = 0;

  private engineState: EngineState = 'unloaded';
  private artifactId: string | null = null;
  private cancelRequested = new Set<string>();
  private cancelWaiters = new Map<string, () => void>();

  state(): EngineState {
    return this.engineState;
  }

  loadedArtifactId(): string | null {
    return this.artifactId;
  }

  async load(artifactId: string): Promise<void> {
    this.events.push(`load:${artifactId}`);
    this.engineState = 'loading';
    await delay(this.script.loadDelayMs);
    if (this.script.failLoadWith) {
      this.engineState = 'error';
      throw this.script.failLoadWith;
    }
    this.loadCount++;
    this.artifactId = artifactId;
    this.engineState = 'ready';
  }

  async countFormattedTokens(messages: ChatMessage[]): Promise<number> {
    if (this.artifactId === null) {
      throw new InferenceFailure('MODEL_LOAD_FAILED', 'count-before-load');
    }
    return approximateTokens(messages);
  }

  async resetSession(): Promise<void> {
    this.resetCount++;
    this.events.push('reset');
  }

  async generate(request: GenerateRequest, onText: (event: TextEvent) => void): Promise<GenerateResult> {
    if (this.engineState !== 'ready') {
      throw new InferenceFailure('MODEL_LOAD_FAILED', `generate-in-${this.engineState}`);
    }
    this.engineState = 'generating';
    this.events.push(`generate:${request.id}`);
    this.prompts.push(request.messages.map(m => ({...m})));
    const script = {...this.script};
    let text = '';
    let emitted = 0;
    try {
      if (script.failGenerationWith) {
        throw script.failGenerationWith;
      }
      for (const token of script.tokens.slice(0, MAX_OUTPUT_TOKENS)) {
        await delay(script.tokenDelayMs);
        if (this.cancelRequested.has(request.id)) {
          if (script.neverAcknowledgeCancel) {
            await new Promise<never>(() => undefined);
          }
          return {requestId: request.id, text, reason: 'cancelled', outputTokens: emitted};
        }
        text += token;
        onText({requestId: request.id, sequence: emitted, delta: token});
        emitted++;
      }
      const reason = script.tokens.length > MAX_OUTPUT_TOKENS ? 'length' : script.finishReason;
      return {
        requestId: request.id,
        text,
        reason,
        promptTokens: approximateTokens(request.messages),
        outputTokens: emitted,
      };
    } finally {
      this.engineState = this.artifactId === null ? 'unloaded' : 'ready';
      this.cancelRequested.delete(request.id);
      this.cancelWaiters.get(request.id)?.();
      this.cancelWaiters.delete(request.id);
    }
  }

  cancel(requestId: string): Promise<void> {
    this.events.push(`cancel:${requestId}`);
    if (this.engineState !== 'generating') {
      return Promise.resolve();
    }
    this.engineState = 'stopping';
    this.cancelRequested.add(requestId);
    return new Promise<void>(resolve => {
      this.cancelWaiters.set(requestId, resolve);
    });
  }

  async unload(): Promise<void> {
    if (this.engineState === 'generating' || this.engineState === 'stopping') {
      throw new Error('unload during generation would free a running context');
    }
    this.events.push('unload');
    this.artifactId = null;
    this.engineState = 'unloaded';
  }

  async runSelfTest(): Promise<SelfTestResult> {
    return {
      passed: this.script.selfTestPasses,
      failureCode: this.script.selfTestPasses ? null : 'MODEL_LOAD_FAILED',
      promptTokens: 128,
      outputTokens: this.script.selfTestPasses ? 32 : 0,
    };
  }
}

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, ms));
}
