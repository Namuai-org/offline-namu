import {
  ChatSessionController,
  type ChatSessionDeps,
  type InstalledArtifact,
  type Timers,
} from '../../src/domain/chat/ChatSessionController';
import {EngineOwnership} from '../../src/domain/inference/EngineOwnership';
import {resolveParameters} from '../../src/domain/inference/productionConfig';
import {FakeInferenceEngine} from '../../src/infrastructure/inference/fake/FakeInferenceEngine';
import {nextId, openTestChatDb, type TestChatDb} from './chatDb';

/** Deterministic timers for the controller only; the fake engine uses real ones. */
export class ManualTimers implements Timers {
  private nowMs = 0;
  private seq = 0;
  private readonly pending = new Map<number, {at: number; fn: () => void}>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, {at: this.nowMs + ms, fn});
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) {
        break;
      }
      this.pending.delete(due[0]);
      this.nowMs = due[1].at;
      due[1].fn();
    }
    this.nowMs = target;
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

export const ARTIFACT: InstalledArtifact = {artifactId: 'b'.repeat(64), sha256: 'b'.repeat(64)};

export interface Harness {
  t: TestChatDb;
  engine: FakeInferenceEngine;
  ownership: EngineOwnership;
  timers: ManualTimers;
  controller: ChatSessionController;
  diagnostics: {code: string; fields: Record<string, unknown>}[];
  marker: string[];
  hooks: string[];
  installed: {current: InstalledArtifact | null};
}

export async function makeHarness(overrides: Partial<ChatSessionDeps> = {}): Promise<Harness> {
  const t = await openTestChatDb();
  const engine = new FakeInferenceEngine();
  const ownership = new EngineOwnership();
  const timers = new ManualTimers();
  const diagnostics: Harness['diagnostics'] = [];
  const marker: string[] = [];
  const hooks: string[] = [];
  const installed = {current: ARTIFACT as InstalledArtifact | null};
  let clock = 1_000;
  const controller = new ChatSessionController({
    engine,
    ownership,
    chat: t.chat,
    conversations: t.conversations,
    installedArtifact: () => installed.current,
    defaultResponseLanguage: () => 'auto',
    parameters: resolveParameters('android', 8),
    newId: () => nextId('gen'),
    now: () => ++clock,
    loadMarker: {
      set: async sha => void marker.push(`set:${sha.slice(0, 4)}`),
      clear: async () => void marker.push('clear'),
    },
    diagnostics: {record: (code, fields = {}) => void diagnostics.push({code, fields})},
    onSuccessfulAnswer: () => void hooks.push('success'),
    onAnswering: () => void hooks.push('answering'),
    onTerminal: status => void hooks.push(`terminal:${status}`),
    timers,
    ...overrides,
  });
  return {t, engine, ownership, timers, controller, diagnostics, marker, hooks, installed};
}

export function waitForIdle(controller: ChatSessionController): Promise<void> {
  return new Promise(resolve => {
    if (controller.getState().active === null) {
      resolve();
      return;
    }
    const off = controller.subscribe(state => {
      if (state.active === null) {
        off();
        resolve();
      }
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Polls instead of guessing a delay, so timing-sensitive tests survive a loaded machine. */
export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('waitUntil timed out');
    }
    await sleep(5);
  }
}
