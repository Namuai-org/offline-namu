import {DomainRuleError, StorageWriteError} from '../../data/Database';
import type {ChatRepository} from '../../data/repositories/ChatRepository';
import type {ConversationRepository} from '../../data/repositories/ConversationRepository';
import {DRAFT_MAX_CODE_POINTS} from '../../data/repositories/DraftRepository';
import type {ContextPair, GenerationRecord, ResponseLanguage, TerminalAttemptStatus} from '../../data/types';
import {codePointLength} from '../text/graphemes';
import type {EngineOwnership} from '../inference/EngineOwnership';
import type {EngineState, FinishReason, GenerateResult, NamuEngine, TextEvent} from '../inference/InferenceEngine';
import {InferenceFailure, type ProductErrorCode} from '../inference/failures';
import {
  CANCEL_ACK_TIMEOUT_MS,
  IDLE_UNLOAD_MS,
  THERMAL_RECOVERY_MS,
  type ResolvedInferenceParameters,
} from '../inference/productionConfig';
import {fitPrompt} from './promptBudget';
import {PROMPT_VERSION, buildSystemPrompt} from './systemPrompt';

/** CHAT-002 cadence. */
export const UI_PUBLISH_INTERVAL_MS = 50;
export const CHECKPOINT_INTERVAL_MS = 1000;
export const CHECKPOINT_BYTES = 1024;
const CONTEXT_PAGE = 30;
const CONTEXT_MAX_PAGES = 10;

export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';
export type MemoryLevel = 'warning' | 'critical';
type StopCause = 'user' | 'background' | 'memory' | 'thermal' | 'storage' | 'shutdown';

export interface ActiveGeneration {
  requestId: string;
  conversationId: string | null;
  turnId: string | null;
  attemptId: string | null;
  /** preparing = loading/budgeting before the turn is committed. */
  phase: 'preparing' | 'answering' | 'stopping';
  /** CTX-004 quiet notice. */
  contextTrimmed: boolean;
}

export type BlockReason = 'DEVICE_HOT' | 'CANCEL_TIMEOUT' | 'SAFE_MODE';

export interface ChatSessionState {
  engine: EngineState;
  active: ActiveGeneration | null;
  blocked: BlockReason | null;
  /** Latest product error for the visible conversation, cleared on the next send. */
  lastError: {code: ProductErrorCode; conversationId: string | null; attemptId: string | null} | null;
  /** STORAGE_WRITE_FAILED: text that could not be saved stays available for Copy. */
  unsaved: {attemptId: string; text: string} | null;
}

export type SendOutcome =
  | {accepted: true; conversationId: string; turnId: string; attemptId: string; isNewConversation: boolean}
  | {accepted: false; code: ProductErrorCode | 'BUSY' | 'MODEL_MISSING' | 'EMPTY' | 'CANCELLED'};

export interface StreamSnapshot {
  attemptId: string;
  text: string;
}

export interface InstalledArtifact {
  artifactId: string;
  sha256: string;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ChatSessionDeps {
  engine: NamuEngine;
  ownership: EngineOwnership;
  chat: ChatRepository;
  conversations: ConversationRepository;
  /** Active pointer mirror; null when no model is installed. */
  installedArtifact: () => InstalledArtifact | null;
  defaultResponseLanguage: () => ResponseLanguage;
  parameters: ResolvedInferenceParameters;
  newId: () => string;
  now: () => number;
  /** ERR-001 durable marker around native loads. */
  loadMarker: {set(artifactSha256: string): Promise<void>; clear(): Promise<void>};
  diagnostics: {record(code: string, fields?: Record<string, number | string | boolean | null | undefined>): void};
  /** DL-013: called once per app session after the first successful answer. */
  onSuccessfulAnswer?: () => void;
  /** A11Y-001 / DS-004 hooks: fired once per generation. */
  onAnswering?: () => void;
  onTerminal?: (status: TerminalAttemptStatus) => void;
  timers?: Timers;
  safeModeAtStart?: boolean;
}

interface RunContext {
  active: ActiveGeneration;
  text: string;
  lastSequence: number;
  stopCause: StopCause | null;
  stopErrorCode: ProductErrorCode | null;
  cancelRequestedBeforeCommit: boolean;
  finalized: boolean;
  checkpointedLength: number;
  bytesSinceCheckpoint: number;
  checkpointTimer: unknown;
  checkpointInFlight: Promise<void> | null;
  publishTimer: unknown;
  firstTokenAt: number | null;
  startedAt: number;
  promptTokens: number | null;
}

/**
 * Application-scoped owner of the single model context and the single active
 * generation (ARC-002). Screens subscribe; navigation never owns the context.
 */
export class ChatSessionController {
  private state: ChatSessionState;
  private readonly stateListeners = new Set<(s: ChatSessionState) => void>();
  private readonly streamListeners = new Set<(s: StreamSnapshot) => void>();
  private readonly timers: Timers;
  private run: RunContext | null = null;
  private idleTimer: unknown = null;
  private thermalTimer: unknown = null;
  private sessionSuccessReported = false;

  constructor(private readonly deps: ChatSessionDeps) {
    this.timers = deps.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.state = {
      engine: deps.engine.state(),
      active: null,
      blocked: deps.safeModeAtStart ? 'SAFE_MODE' : null,
      lastError: null,
      unsaved: null,
    };
  }

  // ---------------------------------------------------------------- observe

  getState(): ChatSessionState {
    return this.state;
  }

  subscribe(listener: (s: ChatSessionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Coalesced text for the active-message component (CHAT-002: every 50 ms). */
  subscribeStream(listener: (s: StreamSnapshot) => void): () => void {
    this.streamListeners.add(listener);
    if (this.run?.active.attemptId) {
      listener({attemptId: this.run.active.attemptId, text: this.run.text});
    }
    return () => this.streamListeners.delete(listener);
  }

  currentStreamText(attemptId: string): string | null {
    return this.run?.active.attemptId === attemptId ? this.run.text : null;
  }

  private setState(patch: Partial<ChatSessionState>): void {
    this.state = {...this.state, ...patch, engine: this.deps.engine.state()};
    for (const listener of this.stateListeners) {
      listener(this.state);
    }
  }

  // ------------------------------------------------------------------- send

  /** CHAT-001. Resolves once the turn is durably committed (or refused). */
  send(conversationId: string | null, rawText: string): Promise<SendOutcome> {
    return this.start({kind: 'send', conversationId, text: rawText});
  }

  /** CHAT-004: new attempt for the latest turn's same user message. */
  retry(conversationId: string, turnId: string): Promise<SendOutcome> {
    return this.start({kind: 'retry', conversationId, turnId});
  }

  private start(
    request:
      | {kind: 'send'; conversationId: string | null; text: string}
      | {kind: 'retry'; conversationId: string; turnId: string},
  ): Promise<SendOutcome> {
    if (this.run) {
      // CHAT-006: no hidden queue; the UI must offer "Stop current answer".
      return Promise.resolve({accepted: false, code: 'BUSY'});
    }
    if (this.state.blocked === 'CANCEL_TIMEOUT') {
      return Promise.resolve({accepted: false, code: 'CANCEL_TIMEOUT'});
    }
    if (this.state.blocked === 'DEVICE_HOT') {
      return Promise.resolve({accepted: false, code: 'DEVICE_HOT'});
    }
    if (this.state.blocked === 'SAFE_MODE') {
      return Promise.resolve({accepted: false, code: 'MODEL_LOAD_FAILED'});
    }
    if (request.kind === 'send') {
      if (request.text.trim().length === 0) {
        return Promise.resolve({accepted: false, code: 'EMPTY'});
      }
      if (codePointLength(request.text) > DRAFT_MAX_CODE_POINTS) {
        return Promise.resolve({accepted: false, code: 'INPUT_TOO_LONG'});
      }
    }
    const artifact = this.deps.installedArtifact();
    if (!artifact) {
      return Promise.resolve({accepted: false, code: 'MODEL_MISSING'});
    }

    const run: RunContext = {
      active: {
        requestId: this.deps.newId(),
        conversationId: request.conversationId,
        turnId: request.kind === 'retry' ? request.turnId : null,
        attemptId: null,
        phase: 'preparing',
        contextTrimmed: false,
      },
      text: '',
      lastSequence: -1,
      stopCause: null,
      stopErrorCode: null,
      cancelRequestedBeforeCommit: false,
      finalized: false,
      checkpointedLength: 0,
      bytesSinceCheckpoint: 0,
      checkpointTimer: null,
      checkpointInFlight: null,
      publishTimer: null,
      firstTokenAt: null,
      startedAt: this.deps.now(),
      promptTokens: null,
    };
    this.run = run;
    this.cancelIdleTimer();
    this.setState({active: run.active, lastError: null, unsaved: null});

    return new Promise<SendOutcome>(resolve => {
      let resolved = false;
      const settle = (outcome: SendOutcome) => {
        if (!resolved) {
          resolved = true;
          resolve(outcome);
        }
      };
      // The ownership lock is held from load through the terminal commit so
      // activation or idle unload can never interleave (INF-006).
      this.deps.ownership
        .run('generate', async () => {
          try {
            await this.pipeline(run, request, artifact, settle);
          } finally {
            await this.releaseAfterSystemStop(run);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          settle({accepted: false, code: 'ANSWER_INTERRUPTED'});
          this.endRun(run);
        });
    });
  }

  private async pipeline(
    run: RunContext,
    request:
      | {kind: 'send'; conversationId: string | null; text: string}
      | {kind: 'retry'; conversationId: string; turnId: string},
    artifact: InstalledArtifact,
    settle: (outcome: SendOutcome) => void,
  ): Promise<void> {
    const {engine, chat, conversations, diagnostics} = this.deps;

    // 1. Lazy load (INF-007) behind the crash marker (ERR-001).
    try {
      await this.ensureLoaded(artifact);
    } catch (error) {
      const code = error instanceof InferenceFailure ? error.code : 'MODEL_LOAD_FAILED';
      this.setState({lastError: {code, conversationId: request.conversationId, attemptId: null}});
      settle({accepted: false, code});
      return;
    }
    if (run.cancelRequestedBeforeCommit) {
      settle({accepted: false, code: 'CANCELLED'});
      return;
    }

    // 2. Resolve the user text, language and history.
    let userText: string;
    let language: ResponseLanguage;
    let beforeOrdinal: number;
    if (request.kind === 'retry') {
      const turn = await chat.getTurn(request.turnId);
      const conversation = await conversations.get(request.conversationId);
      if (!turn || !conversation) {
        settle({accepted: false, code: 'ANSWER_INTERRUPTED'});
        return;
      }
      userText = turn.userText;
      language = conversation.responseLanguage;
      beforeOrdinal = turn.ordinal;
    } else {
      userText = request.text;
      const conversation = request.conversationId ? await conversations.get(request.conversationId) : null;
      language = conversation?.responseLanguage ?? this.deps.defaultResponseLanguage();
      beforeOrdinal = Number.MAX_SAFE_INTEGER;
    }

    // 3. Budget the exact formatted prompt (CTX-002, CTX-003).
    const formatStart = this.deps.now();
    const systemPrompt = buildSystemPrompt(language);
    const pairs: ContextPair[] = [];
    let more = request.conversationId !== null;
    let fit = await fitPrompt({
      systemPrompt, currentUserText: userText, pairsNewestFirst: pairs,
      moreHistoryAvailable: false, count: m => engine.countFormattedTokens(m),
    });
    for (let page = 0; fit.ok && more && page < CONTEXT_MAX_PAGES; page++) {
      const next = await chat.getContextPairs(request.conversationId!, beforeOrdinal, CONTEXT_PAGE, page * CONTEXT_PAGE);
      pairs.push(...next);
      more = next.length === CONTEXT_PAGE;
      fit = await fitPrompt({
        systemPrompt, currentUserText: userText, pairsNewestFirst: pairs,
        moreHistoryAvailable: more, count: m => engine.countFormattedTokens(m),
      });
      if (fit.ok && fit.includedPairs < pairs.length) {
        break; // budget exhausted; older pages cannot fit either
      }
    }
    if (!fit.ok) {
      // Draft is retained by the caller; the message is never truncated.
      diagnostics.record('INPUT_TOO_LONG', {countedTokens: fit.promptTokens});
      this.setState({lastError: {code: 'INPUT_TOO_LONG', conversationId: request.conversationId, attemptId: null}});
      settle({accepted: false, code: 'INPUT_TOO_LONG'});
      return;
    }
    diagnostics.record('prompt.budget', {
      formatMs: this.deps.now() - formatStart,
      countedTokens: fit.promptTokens,
      includedPairs: fit.includedPairs,
      trimmedPairs: pairs.length - fit.includedPairs,
    });
    if (run.cancelRequestedBeforeCommit) {
      settle({accepted: false, code: 'CANCELLED'});
      return;
    }

    // 4. Durable commit BEFORE inference (CHAT-001).
    const generation: GenerationRecord = {
      artifactSha256: artifact.sha256,
      runtimeBuildId: this.deps.parameters.runtimeBuildId,
      promptVersion: PROMPT_VERSION,
      parametersJson: JSON.stringify(this.deps.parameters),
    };
    let conversationId: string;
    let turnId: string;
    let attemptId: string;
    let isNewConversation = false;
    const commitStart = this.deps.now();
    try {
      if (request.kind === 'retry') {
        const created = await chat.createRetryAttempt({
          turnId: request.turnId,
          generation,
          ids: {attemptId: this.deps.newId(), generationId: run.active.requestId},
          now: this.deps.now(),
        });
        conversationId = created.conversationId;
        turnId = request.turnId;
        attemptId = created.attemptId;
      } else {
        const sent = await chat.send({
          conversationId: request.conversationId,
          userText,
          defaultResponseLanguage: this.deps.defaultResponseLanguage(),
          generation,
          ids: {
            conversationId: this.deps.newId(),
            turnId: this.deps.newId(),
            attemptId: this.deps.newId(),
            generationId: run.active.requestId,
          },
          now: this.deps.now(),
        });
        conversationId = sent.conversation.id;
        turnId = sent.turnId;
        attemptId = sent.attemptId;
        isNewConversation = sent.isNewConversation;
      }
    } catch (error) {
      const code: ProductErrorCode = error instanceof DomainRuleError ? 'ANSWER_INTERRUPTED' : 'STORAGE_WRITE_FAILED';
      this.setState({lastError: {code, conversationId: request.conversationId, attemptId: null}});
      settle({accepted: false, code});
      return;
    }
    diagnostics.record('db.commit', {commitMs: this.deps.now() - commitStart});

    run.active = {...run.active, conversationId, turnId, attemptId, phase: 'answering', contextTrimmed: fit.trimmed};
    run.promptTokens = fit.promptTokens;
    this.setState({active: run.active});
    settle({accepted: true, conversationId, turnId, attemptId, isNewConversation});
    this.deps.onAnswering?.();

    // 5. Generate. A stop requested between commit and here still ends cleanly.
    let result: GenerateResult;
    try {
      await chat.markStreaming(attemptId, fit.promptTokens, this.deps.now());
      if (run.stopCause) {
        result = {requestId: run.active.requestId, text: '', reason: 'cancelled'};
      } else {
        await engine.resetSession(); // INF-004 / T17
        this.setState({});
        result = await engine.generate(
          {id: run.active.requestId, conversationId, messages: fit.messages},
          event => this.onText(run, event),
        );
      }
    } catch (error) {
      const code = error instanceof InferenceFailure ? error.code : 'ANSWER_INTERRUPTED';
      await this.finalize(run, 'error', run.text, code, null);
      return;
    }
    // The engine's final text is authoritative (stop sequences already removed);
    // fall back to what was streamed if the runtime returned nothing.
    await this.finalize(run, result.reason, result.text.length > 0 ? result.text : run.text, null, result);
  }

  /** INF-007/008: system-initiated stops release model memory once acknowledged. */
  private async releaseAfterSystemStop(run: RunContext): Promise<void> {
    const systemStop = run.stopCause === 'background' || run.stopCause === 'memory' || run.stopCause === 'thermal';
    if (!systemStop || this.state.blocked === 'CANCEL_TIMEOUT') {
      return;
    }
    if (this.deps.engine.loadedArtifactId() !== null) {
      const start = this.deps.now();
      await this.deps.engine.unload().catch(() => undefined);
      this.deps.diagnostics.record('engine.unload', {unloadMs: this.deps.now() - start, reason: run.stopCause});
    }
  }

  private async ensureLoaded(artifact: InstalledArtifact): Promise<void> {
    const {engine, diagnostics, loadMarker} = this.deps;
    if (engine.state() === 'ready' && engine.loadedArtifactId() === artifact.artifactId) {
      return;
    }
    if (engine.loadedArtifactId() !== null) {
      await engine.unload();
    }
    const start = this.deps.now();
    await loadMarker.set(artifact.sha256);
    this.setState({});
    try {
      const loading = engine.load(artifact.artifactId);
      this.setState({});
      await loading;
      diagnostics.record('engine.load', {loadMs: this.deps.now() - start, accepted: true});
    } catch (error) {
      diagnostics.record('engine.load', {
        loadMs: this.deps.now() - start,
        accepted: false,
        errorCode: error instanceof InferenceFailure ? error.code : 'MODEL_LOAD_FAILED',
      });
      throw error;
    } finally {
      // A caught failure is not a crash: clear the marker either way (ERR-001).
      await loadMarker.clear().catch(() => undefined);
      this.setState({});
    }
  }

  // ---------------------------------------------------------------- streaming

  private onText(run: RunContext, event: TextEvent): void {
    // INF-005: drop chunks for obsolete requests and out-of-order sequences.
    if (this.run !== run || event.requestId !== run.active.requestId || run.finalized) {
      return;
    }
    if (event.sequence <= run.lastSequence) {
      return;
    }
    run.lastSequence = event.sequence;
    if (run.firstTokenAt === null) {
      run.firstTokenAt = this.deps.now();
      this.deps.diagnostics.record('engine.firstToken', {firstTokenMs: run.firstTokenAt - run.startedAt});
    }
    run.text += event.delta;
    run.bytesSinceCheckpoint += utf8Length(event.delta);

    if (run.publishTimer === null) {
      run.publishTimer = this.timers.setTimeout(() => {
        run.publishTimer = null;
        this.publish(run);
      }, UI_PUBLISH_INTERVAL_MS);
    }
    if (run.bytesSinceCheckpoint >= CHECKPOINT_BYTES) {
      this.checkpoint(run);
    } else if (run.checkpointTimer === null) {
      run.checkpointTimer = this.timers.setTimeout(() => {
        run.checkpointTimer = null;
        this.checkpoint(run);
      }, CHECKPOINT_INTERVAL_MS);
    }
  }

  private publish(run: RunContext): void {
    if (!run.active.attemptId) {
      return;
    }
    const snapshot = {attemptId: run.active.attemptId, text: run.text};
    for (const listener of this.streamListeners) {
      listener(snapshot);
    }
  }

  /** CHAT-002: every 1 s or 1 KiB of new text, never overlapping. */
  private checkpoint(run: RunContext): Promise<void> {
    if (run.finalized || !run.active.attemptId || run.text.length === run.checkpointedLength) {
      return run.checkpointInFlight ?? Promise.resolve();
    }
    if (run.checkpointInFlight) {
      return run.checkpointInFlight;
    }
    if (run.checkpointTimer !== null) {
      this.timers.clearTimeout(run.checkpointTimer);
      run.checkpointTimer = null;
    }
    const text = run.text;
    run.bytesSinceCheckpoint = 0;
    const attemptId = run.active.attemptId;
    run.checkpointInFlight = this.deps.chat
      .checkpoint(attemptId, text, this.deps.now())
      .then(() => {
        run.checkpointedLength = text.length;
      })
      .catch(error => {
        if (error instanceof StorageWriteError) {
          // STORAGE_WRITE_FAILED: stop inference, keep the text visible for Copy.
          this.requestStop(run, 'storage', 'STORAGE_WRITE_FAILED');
        }
      })
      .finally(() => {
        run.checkpointInFlight = null;
      });
    return run.checkpointInFlight;
  }

  // --------------------------------------------------------------------- stop

  /** User Stop. UI acknowledgement is synchronous (NFR-005). */
  stop(): void {
    if (this.run) {
      this.requestStop(this.run, 'user', null);
    }
  }

  private requestStop(run: RunContext, cause: StopCause, errorCode: ProductErrorCode | null): void {
    if (run.finalized || run.stopCause) {
      return; // Stop twice is a no-op (T14)
    }
    run.stopCause = cause;
    run.stopErrorCode = errorCode;
    if (run.active.phase === 'preparing') {
      run.cancelRequestedBeforeCommit = true;
      return;
    }
    run.active = {...run.active, phase: 'stopping'};
    this.setState({active: run.active});
    const stopStart = this.deps.now();
    if (run.active.attemptId) {
      void this.deps.chat.markStopping(run.active.attemptId, stopStart).catch(() => undefined);
    }

    // Out-of-band: never queued behind the ownership lock (INF-006).
    let acknowledged = false;
    const timeout = this.timers.setTimeout(() => {
      if (!acknowledged && !run.finalized) {
        // Never free a running context; require the user to reopen the app.
        this.deps.diagnostics.record('engine.stop', {stopMs: CANCEL_ACK_TIMEOUT_MS, errorCode: 'CANCEL_TIMEOUT'});
        this.setState({
          blocked: 'CANCEL_TIMEOUT',
          lastError: {code: 'CANCEL_TIMEOUT', conversationId: run.active.conversationId, attemptId: run.active.attemptId},
        });
      }
    }, CANCEL_ACK_TIMEOUT_MS);
    this.deps.engine
      .cancel(run.active.requestId)
      .then(() => {
        acknowledged = true;
        this.deps.diagnostics.record('engine.stop', {stopMs: this.deps.now() - stopStart});
      })
      .catch(() => undefined)
      .finally(() => this.timers.clearTimeout(timeout));
  }

  // ----------------------------------------------------------------- terminal

  /** Exactly-once terminal transition (CHAT-003). */
  private async finalize(
    run: RunContext,
    reason: FinishReason,
    text: string,
    failureCode: ProductErrorCode | null,
    result: GenerateResult | null,
  ): Promise<void> {
    if (run.finalized) {
      return;
    }
    run.finalized = true;
    if (run.publishTimer !== null) {
      this.timers.clearTimeout(run.publishTimer);
      run.publishTimer = null;
    }
    if (run.checkpointTimer !== null) {
      this.timers.clearTimeout(run.checkpointTimer);
      run.checkpointTimer = null;
    }
    await run.checkpointInFlight?.catch(() => undefined);
    run.text = text;
    this.publish(run);

    let status: TerminalAttemptStatus;
    let finishReason: string = reason;
    let errorCode: ProductErrorCode | null = failureCode;
    if (reason === 'eos' || reason === 'length') {
      status = 'complete';
    } else if (reason === 'cancelled' && (run.stopCause === 'user' || run.stopCause === null)) {
      status = 'stopped';
    } else if (reason === 'cancelled' || reason === 'interrupted') {
      status = 'interrupted';
      finishReason = 'interrupted';
      errorCode = run.stopErrorCode ?? 'ANSWER_INTERRUPTED';
    } else {
      status = 'failed';
      errorCode = failureCode ?? 'ANSWER_INTERRUPTED';
    }

    const attemptId = run.active.attemptId!;
    const commitStart = this.deps.now();
    let saved = true;
    try {
      await this.deps.chat.finishAttempt({
        attemptId,
        status,
        finishReason,
        content: text,
        promptTokens: result?.promptTokens ?? run.promptTokens,
        outputTokens: result?.outputTokens ?? null,
        errorCode,
        now: this.deps.now(),
      });
    } catch {
      saved = false;
      errorCode = 'STORAGE_WRITE_FAILED';
    }
    this.deps.diagnostics.record('generation.end', {
      finishReason,
      errorCode,
      promptTokens: result?.promptTokens ?? run.promptTokens,
      evaluatedTokens: result?.promptTokens,
      countedTokens: run.promptTokens,
      outputTokens: result?.outputTokens,
      prefillMs: result?.timings?.prefillMs,
      decodeMs: result?.timings?.decodeMs,
      tokensPerSecond: result?.timings?.tokensPerSecond,
      commitMs: this.deps.now() - commitStart,
      durationMs: this.deps.now() - run.startedAt,
    });

    this.setState({
      lastError: errorCode
        ? {code: errorCode, conversationId: run.active.conversationId, attemptId}
        : null,
      unsaved: saved ? null : {attemptId, text},
    });
    this.deps.onTerminal?.(status);
    if (status === 'complete' && saved && !this.sessionSuccessReported) {
      this.sessionSuccessReported = true;
      this.deps.onSuccessfulAnswer?.();
    }
  }

  private endRun(run: RunContext): void {
    if (this.run === run) {
      this.run = null;
      this.setState({active: null});
      this.armIdleTimer();
    }
  }

  // ---------------------------------------------------------------- lifecycle

  /** INF-007: checkpoint, cancel and release as soon as acknowledged. */
  onBackground(): void {
    const run = this.run;
    if (run) {
      void this.checkpoint(run);
      this.requestStop(run, 'background', 'ANSWER_INTERRUPTED');
    } else {
      void this.unloadIfIdle('background');
    }
  }

  onMemoryPressure(level: MemoryLevel): void {
    this.deps.diagnostics.record('memory.pressure', {memoryLevel: level});
    const run = this.run;
    if (run && level === 'critical') {
      void this.checkpoint(run);
      this.requestStop(run, 'memory', 'MEMORY_LOW');
    } else if (!run) {
      void this.unloadIfIdle('memory');
    }
  }

  /** INF-008: severe → stop + unload; unblock after 30 s of non-severe readings. */
  onThermalState(state: ThermalState): void {
    this.deps.diagnostics.record('thermal.state', {thermalState: state});
    const severe = state === 'serious' || state === 'critical';
    if (severe) {
      if (this.thermalTimer !== null) {
        this.timers.clearTimeout(this.thermalTimer);
        this.thermalTimer = null;
      }
      if (this.state.blocked !== 'CANCEL_TIMEOUT') {
        this.setState({blocked: 'DEVICE_HOT'});
      }
      const run = this.run;
      if (run) {
        void this.checkpoint(run);
        this.requestStop(run, 'thermal', 'DEVICE_HOT');
      } else {
        void this.unloadIfIdle('thermal');
      }
      return;
    }
    if (this.state.blocked === 'DEVICE_HOT' && this.thermalTimer === null) {
      this.thermalTimer = this.timers.setTimeout(() => {
        this.thermalTimer = null;
        if (this.state.blocked === 'DEVICE_HOT') {
          this.setState({blocked: null});
        }
      }, THERMAL_RECOVERY_MS);
    }
  }

  /** ERR-001: the user explicitly chose to try loading again after a crash. */
  leaveSafeMode(): void {
    if (this.state.blocked === 'SAFE_MODE') {
      this.setState({blocked: null});
    }
  }

  /**
   * Used before activation/self-test, model removal and data deletion
   * (DL-011, SEC-006): stop any answer, then unload under the ownership lock.
   * Resolves false when shutdown could not be confirmed.
   */
  async quiesce(): Promise<boolean> {
    if (this.state.blocked === 'CANCEL_TIMEOUT') {
      return false;
    }
    const run = this.run;
    if (run) {
      this.requestStop(run, 'shutdown', 'ANSWER_INTERRUPTED');
    }
    const unloaded = this.deps.ownership
      .run('unload', async () => {
        // Re-checked inside the lock: a running context is never freed.
        if (this.state.blocked !== 'CANCEL_TIMEOUT' && this.deps.engine.loadedArtifactId() !== null) {
          await this.deps.engine.unload();
        }
      })
      .then(() => 'done' as const, () => 'done' as const);
    // If the stop is never acknowledged the lock is never released; give up
    // waiting as soon as CANCEL_TIMEOUT is declared instead of hanging.
    let unsubscribe: () => void = () => undefined;
    const timedOut = new Promise<'timeout'>(resolve => {
      unsubscribe = this.subscribe(state => {
        if (state.blocked === 'CANCEL_TIMEOUT') {
          resolve('timeout');
        }
      });
    });
    const outcome = await Promise.race([unloaded, timedOut]);
    unsubscribe();
    this.setState({});
    return outcome === 'done' && !this.cancelTimedOut() && this.deps.engine.loadedArtifactId() === null;
  }

  private cancelTimedOut(): boolean {
    return this.state.blocked === 'CANCEL_TIMEOUT';
  }

  isGeneratingIn(conversationId: string): boolean {
    return this.run?.active.conversationId === conversationId;
  }

  // --------------------------------------------------------------------- idle

  private armIdleTimer(): void {
    this.cancelIdleTimer();
    if (this.deps.engine.loadedArtifactId() === null) {
      return;
    }
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = null;
      void this.unloadIfIdle('idle');
    }, IDLE_UNLOAD_MS);
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer !== null) {
      this.timers.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async unloadIfIdle(reason: string): Promise<void> {
    if (this.run || this.state.blocked === 'CANCEL_TIMEOUT') {
      return;
    }
    await this.deps.ownership.run('unload', async () => {
      if (!this.run && this.deps.engine.loadedArtifactId() !== null) {
        const start = this.deps.now();
        await this.deps.engine.unload().catch(() => undefined);
        this.deps.diagnostics.record('engine.unload', {unloadMs: this.deps.now() - start, reason});
      }
    });
    this.cancelIdleTimer();
    this.setState({});
  }
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}
