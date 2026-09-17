import type {ChatSessionController, InstalledArtifact} from '../chat/ChatSessionController';
import type {EngineOwnership} from '../inference/EngineOwnership';
import type {NamuEngine} from '../inference/InferenceEngine';
import {InferenceFailure} from '../inference/failures';
import type {TransferService} from './services';
import {EMPTY_SNAPSHOT, type TransferSnapshot} from './transferTypes';

export type FinishSetupResult =
  | {ok: true}
  | {ok: false; reason: 'busy' | 'not-staged' | 'shutdown-unconfirmed' | 'self-test-failed' | 'native-error'};

export interface ModelInstallDeps {
  transfer: TransferService;
  engine: NamuEngine;
  ownership: EngineOwnership;
  chat: () => ChatSessionController;
  loadMarker: {set(artifactSha256: string): Promise<void>; clear(): Promise<void>};
  diagnostics: {record(code: string, fields?: Record<string, number | string | boolean | null | undefined>): void};
}

/**
 * Observes the native transfer service and drives the foreground half of the
 * installation sequence (DL-010/011): self-test and activation request.
 *
 * It mirrors snapshots for the UI but can never declare an artifact installed:
 * only the native active pointer does that (ARC-003).
 */
export class ModelInstallController {
  private snapshotValue: TransferSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<(s: TransferSnapshot) => void>();
  private unsubscribeNative: (() => void) | null = null;
  private finishing = false;

  constructor(private readonly deps: ModelInstallDeps) {}

  async start(): Promise<void> {
    this.unsubscribeNative = this.deps.transfer.subscribe(s => this.accept(s));
    this.accept(await this.deps.transfer.snapshot());
  }

  stop(): void {
    this.unsubscribeNative?.();
    this.unsubscribeNative = null;
  }

  snapshot(): TransferSnapshot {
    return this.snapshotValue;
  }

  subscribe(listener: (s: TransferSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Active pointer mirror for the chat controller. */
  installedArtifact(): InstalledArtifact | null {
    const {install} = this.snapshotValue;
    if (install.state !== 'installed' || !install.active) {
      return null;
    }
    return {artifactId: install.active.artifactId, sha256: install.active.sha256};
  }

  async refresh(): Promise<TransferSnapshot> {
    this.accept(await this.deps.transfer.snapshot());
    return this.snapshotValue;
  }

  private accept(snapshot: TransferSnapshot): void {
    this.snapshotValue = snapshot;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  isFinishing(): boolean {
    return this.finishing;
  }

  /**
   * Foreground self-test and activation for a `staged` transfer.
   *
   * First install: called automatically by the setup screen when it sees
   * `staged`. Update: called only from the explicit "Install update" action
   * while no answer is running (T11: activation waits for an explicit idle
   * transition). Old and new contexts are never held together (DL-011).
   */
  async finishStagedInstall(): Promise<FinishSetupResult> {
    const transfer = this.snapshotValue.transfer;
    if (!transfer || transfer.phase !== 'staged') {
      return {ok: false, reason: 'not-staged'};
    }
    if (this.finishing) {
      return {ok: false, reason: 'busy'};
    }
    this.finishing = true;
    const {engine, ownership, diagnostics, loadMarker} = this.deps;
    try {
      // Cancel/await any generation and release its context first.
      const quiet = await this.deps.chat().quiesce();
      if (!quiet) {
        return {ok: false, reason: 'shutdown-unconfirmed'};
      }
      return await ownership.run('activation', async (): Promise<FinishSetupResult> => {
        let candidateId: string;
        try {
          candidateId = await this.deps.transfer.beginSelfTest(transfer.transferId); // pending marker (DL-012)
        } catch {
          return {ok: false, reason: 'native-error'};
        }
        const start = Date.now();
        let passed = false;
        let failureCode = 'MODEL_LOAD_FAILED';
        await loadMarker.set(transfer.artifactSha256);
        try {
          await engine.load(candidateId);
          const result = await engine.runSelfTest();
          passed = result.passed;
          failureCode = result.failureCode ?? 'MODEL_LOAD_FAILED';
          diagnostics.record('install.selfTest', {
            accepted: passed,
            promptTokens: result.promptTokens,
            outputTokens: result.outputTokens,
            durationMs: Date.now() - start,
          });
        } catch (error) {
          failureCode = error instanceof InferenceFailure ? error.code : 'MODEL_LOAD_FAILED';
          diagnostics.record('install.selfTest', {accepted: false, errorCode: failureCode});
        } finally {
          // The candidate context is always released; a failure never leaves
          // it loaded and the old weights reload only on explicit user action.
          await engine.unload().catch(() => undefined);
          await loadMarker.clear().catch(() => undefined);
        }
        try {
          this.accept(await this.deps.transfer.activate(transfer.transferId, passed, passed ? '' : failureCode));
        } catch {
          await this.refresh().catch(() => undefined);
          return {ok: false, reason: 'native-error'};
        }
        return passed ? {ok: true} : {ok: false, reason: 'self-test-failed'};
      });
    } finally {
      this.finishing = false;
    }
  }

  /** S07 Remove offline AI: cancel transfers and unload before file deletion. */
  async removeModel(): Promise<boolean> {
    const quiet = await this.deps.chat().quiesce();
    if (!quiet) {
      return false;
    }
    const transfer = this.snapshotValue.transfer;
    if (transfer && transfer.phase !== 'installed') {
      await this.deps.transfer.cancel(transfer.transferId).catch(() => undefined);
    }
    await this.deps.transfer.removeModel();
    await this.refresh();
    return true;
  }

  async restorePrevious(): Promise<boolean> {
    const quiet = await this.deps.chat().quiesce();
    if (!quiet) {
      return false;
    }
    this.accept(await this.deps.transfer.restorePrevious());
    return true;
  }

  async repair(): Promise<void> {
    const quiet = await this.deps.chat().quiesce();
    if (!quiet) {
      return;
    }
    this.accept(await this.deps.transfer.repair());
  }
}
