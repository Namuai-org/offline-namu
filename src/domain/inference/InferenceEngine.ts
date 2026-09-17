/**
 * Namu-owned inference contract (PRD section 9). It is deliberately not the
 * llama.rn API; the only adapter lives in src/infrastructure/inference/.
 */
export type FinishReason = 'eos' | 'length' | 'cancelled' | 'interrupted' | 'error';
export type EngineState = 'unloaded' | 'loading' | 'ready' | 'generating' | 'stopping' | 'error';
export type ChatMessage = {role: 'system' | 'user' | 'assistant'; content: string};

export interface TextEvent {
  requestId: string;
  /** Strictly increasing from 0 within a request (INF-005). */
  sequence: number;
  /** Valid UTF-8 text; never a partial code point. */
  delta: string;
}

export interface GenerateRequest {
  id: string;
  conversationId: string;
  messages: ChatMessage[];
}

export interface GenerateResult {
  requestId: string;
  text: string;
  reason: FinishReason;
  /** Prompt tokens the runtime actually evaluated, when exposed. */
  promptTokens?: number;
  outputTokens?: number;
  timings?: {prefillMs?: number; decodeMs?: number; tokensPerSecond?: number};
}

export interface InferenceEngine {
  load(artifactId: string): Promise<void>;
  countFormattedTokens(messages: ChatMessage[]): Promise<number>;
  generate(request: GenerateRequest, onText: (event: TextEvent) => void): Promise<GenerateResult>;
  /**
   * Out-of-band cooperative stop (INF-006). Resolves when the native layer has
   * acknowledged; it never waits behind the generation it is stopping.
   */
  cancel(requestId: string): Promise<void>;
  unload(): Promise<void>;
  state(): EngineState;
}

/** Optional capabilities the production adapter also offers. */
export interface InferenceEngineExtras {
  /** INF-004: drop native session memory, keep weights loaded. */
  resetSession(): Promise<void>;
  /** Artifact currently held by the runtime, if any. */
  loadedArtifactId(): string | null;
  /** DL-011 deterministic self-test on the loaded context. */
  runSelfTest(): Promise<SelfTestResult>;
}

export interface SelfTestResult {
  passed: boolean;
  failureCode: 'MODEL_LOAD_FAILED' | 'FILE_DAMAGED' | null;
  promptTokens: number;
  outputTokens: number;
}

export type NamuEngine = InferenceEngine & InferenceEngineExtras;
