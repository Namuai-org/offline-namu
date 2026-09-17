import {CHECKPOINT_BYTES} from '../../src/domain/chat/ChatSessionController';
import {InferenceFailure} from '../../src/domain/inference/failures';
import {completedTurn} from '../support/chatDb';
import {makeHarness, sleep, waitForIdle, type Harness} from '../support/controllerHarness';

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.t.db.close();
});

async function attemptRow(attemptId: string) {
  const {rows} = await h.t.db.read(
    `SELECT a.status, a.finish_reason, a.content, g.error_code, g.prompt_tokens
     FROM assistant_attempts a JOIN generations g ON g.attempt_id = a.id WHERE a.id = ?`,
    [attemptId],
  );
  return rows[0]!;
}

describe('send pipeline (CHAT-001, INF-007)', () => {
  it('loads lazily, commits before inference, streams and completes exactly once', async () => {
    expect(h.engine.state()).toBe('unloaded');
    const outcome = await h.controller.send(null, 'Hello Namu');
    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) {
      return;
    }
    await waitForIdle(h.controller);
    expect(h.engine.loadCount).toBe(1);
    expect(h.marker).toEqual(['set:bbbb', 'clear']);
    const row = await attemptRow(outcome.attemptId);
    expect(row).toMatchObject({status: 'complete', finish_reason: 'eos', error_code: null});
    expect(row.content).toBe('This is a **fake** answer for functional tests.');
    expect(h.hooks).toEqual(['answering', 'terminal:complete', 'success']);
    // The prompt is system + user only and carries the fixed language line.
    const prompt = h.engine.prompts[0]!;
    expect(prompt.map(m => m.role)).toEqual(['system', 'user']);
    expect(prompt[0]!.content).toContain('Response language: match the latest user message.');
    expect(prompt[0]!.content).not.toContain('Hello Namu');
  });

  it('reports the successful session only once (DL-013)', async () => {
    const first = await h.controller.send(null, 'one');
    await waitForIdle(h.controller);
    await h.controller.send(first.accepted ? first.conversationId : null, 'two');
    await waitForIdle(h.controller);
    expect(h.hooks.filter(x => x === 'success')).toHaveLength(1);
  });

  it('refuses when no model is installed without touching the database', async () => {
    h.installed.current = null;
    expect(await h.controller.send(null, 'hi')).toEqual({accepted: false, code: 'MODEL_MISSING'});
    expect((await h.t.db.read('SELECT COUNT(*) AS n FROM turns')).rows[0]).toEqual({n: 0});
  });

  it('keeps the draft when the model cannot start (MODEL_LOAD_FAILED) and clears the crash marker', async () => {
    h.engine.script.failLoadWith = new InferenceFailure('MODEL_LOAD_FAILED', 'test');
    const outcome = await h.controller.send(null, 'hi');
    expect(outcome).toEqual({accepted: false, code: 'MODEL_LOAD_FAILED'});
    expect(h.marker).toEqual(['set:bbbb', 'clear']);
    expect((await h.t.db.read('SELECT COUNT(*) AS n FROM turns')).rows[0]).toEqual({n: 0});
    await waitForIdle(h.controller);
    expect(h.controller.getState().lastError?.code).toBe('MODEL_LOAD_FAILED');
  });

  it('stays in safe mode after a native-load crash until the user chooses to retry (ERR-001)', async () => {
    const safe = await makeHarness({safeModeAtStart: true});
    expect(await safe.controller.send(null, 'hi')).toEqual({accepted: false, code: 'MODEL_LOAD_FAILED'});
    expect(safe.engine.loadCount).toBe(0);
    safe.controller.leaveSafeMode();
    expect((await safe.controller.send(null, 'hi')).accepted).toBe(true);
    await waitForIdle(safe.controller);
    await safe.t.db.close();
  });
});

describe('T14 rapid Send twice / Stop twice', () => {
  it('runs a single generation with exactly one terminal event', async () => {
    h.engine.script.tokenDelayMs = 5;
    const [a, b] = await Promise.all([h.controller.send(null, 'first'), h.controller.send(null, 'second')]);
    expect(a.accepted).toBe(true);
    expect(b).toEqual({accepted: false, code: 'BUSY'});
    await sleep(12);
    h.controller.stop();
    h.controller.stop();
    await waitForIdle(h.controller);
    expect(h.engine.events.filter(e => e.startsWith('generate:'))).toHaveLength(1);
    expect(h.engine.events.filter(e => e.startsWith('cancel:'))).toHaveLength(1);
    expect(h.hooks.filter(x => x.startsWith('terminal:'))).toEqual(['terminal:stopped']);
    expect((await h.t.db.read('SELECT COUNT(*) AS n FROM turns')).rows[0]).toEqual({n: 1});
  });
});

describe('T15 cancel during prefill and decode (INF-006)', () => {
  it('stops before the first token and keeps an empty stopped attempt unselected', async () => {
    h.engine.script.tokenDelayMs = 30;
    const outcome = await h.controller.send(null, 'q');
    h.controller.stop();
    expect(h.controller.getState().active?.phase).toBe('stopping'); // synchronous UI acknowledgement
    await waitForIdle(h.controller);
    if (outcome.accepted) {
      expect(await attemptRow(outcome.attemptId)).toMatchObject({status: 'stopped', content: ''});
      expect((await h.t.chat.getTurn(outcome.turnId))?.selectedAttemptId).toBeNull();
    }
    expect(h.engine.events).not.toContain('unload'); // a user stop does not free the context
  });

  it('retains partial output when stopped during decode', async () => {
    h.engine.script.tokenDelayMs = 5;
    const outcome = await h.controller.send(null, 'q');
    await sleep(22);
    h.controller.stop();
    await waitForIdle(h.controller);
    if (outcome.accepted) {
      const row = await attemptRow(outcome.attemptId);
      expect(row.status).toBe('stopped');
      expect(String(row.content).length).toBeGreaterThan(0);
      expect(String(row.content)).not.toBe('This is a **fake** answer for functional tests.');
      expect((await h.t.chat.getTurn(outcome.turnId))?.selectedAttemptId).toBe(outcome.attemptId);
    }
  });

  it('declares CANCEL_TIMEOUT after 5 s, blocks new inference and never frees the running context', async () => {
    h.engine.script.tokenDelayMs = 5;
    h.engine.script.neverAcknowledgeCancel = true;
    const outcome = await h.controller.send(null, 'q');
    expect(outcome.accepted).toBe(true);
    await sleep(12);
    h.controller.stop();
    await sleep(12);
    h.timers.advance(4999);
    expect(h.controller.getState().blocked).toBeNull();
    h.timers.advance(1);
    expect(h.controller.getState().blocked).toBe('CANCEL_TIMEOUT');
    expect(h.controller.getState().lastError?.code).toBe('CANCEL_TIMEOUT');
    expect(h.engine.events).not.toContain('unload');
    expect(await h.controller.quiesce()).toBe(false); // deletion must be deferred (SEC-006)
    expect(h.engine.events).not.toContain('unload');
    h.controller.onBackground();
    h.controller.onMemoryPressure('critical');
    await sleep(5);
    expect(h.engine.events).not.toContain('unload');
  });
});

describe('T16 kill while streaming (CHAT-002)', () => {
  it('checkpoints by time and size; a crash leaves the user message and an interrupted partial', async () => {
    const big = 'x'.repeat(300);
    h.engine.script.tokens = [big, big, big, big, 'tail'];
    h.engine.script.tokenDelayMs = 5;
    const outcome = await h.controller.send(null, 'will crash');
    if (!outcome.accepted) {
      throw new Error('not accepted');
    }
    await sleep(40); // 4 × 300 bytes ≥ 1 KiB → size checkpoint fired
    expect(4 * 300).toBeGreaterThanOrEqual(CHECKPOINT_BYTES);
    const mid = await attemptRow(outcome.attemptId);
    expect(String(mid.content).length).toBeGreaterThanOrEqual(1200);
    await waitForIdle(h.controller);

    // Second generation is "killed": only the timed checkpoint reaches disk.
    h.engine.script.tokens = ['partial ', 'answer ', 'never ', 'finished'];
    h.engine.script.tokenDelayMs = 10;
    h.engine.script.neverAcknowledgeCancel = true;
    const second = await h.controller.send(outcome.conversationId, 'second question');
    if (!second.accepted) {
      throw new Error('not accepted');
    }
    await sleep(25);
    h.timers.advance(1000); // CHECKPOINT_INTERVAL_MS
    await sleep(5);
    // --- process death: a new process only runs recovery ---
    expect(await h.t.chat.recoverInterruptedAttempts(9_999)).toBe(1);
    const turn = await h.t.chat.getTurn(second.turnId);
    expect(turn?.userText).toBe('second question');
    expect(turn?.displayAttempt?.status).toBe('interrupted');
    expect(turn?.displayAttempt?.content.startsWith('partial ')).toBe(true);
  });

  it('coalesces UI text publication to the 50 ms cadence', async () => {
    h.engine.script.tokenDelayMs = 2;
    const published: string[] = [];
    h.controller.subscribeStream(s => published.push(s.text));
    await h.controller.send(null, 'q');
    await sleep(10);
    expect(published).toEqual([]); // buffered, not per token
    h.timers.advance(50);
    expect(published.length).toBe(1);
    await waitForIdle(h.controller);
    expect(published[published.length - 1]).toBe('This is a **fake** answer for functional tests.');
  });
});

describe('T17 cross-conversation isolation (INF-004)', () => {
  it('never leaks a sentinel from another conversation into the prompt or session', async () => {
    const a = await completedTurn(h.t, null, 'my secret is SECRET-SENTINEL-7781', 'I will remember SECRET-SENTINEL-7781', 10);
    const b = await completedTurn(h.t, null, 'unrelated chat', 'fine', 20);
    await h.controller.send(a.conversationId, 'what was it?');
    await waitForIdle(h.controller);
    await h.controller.send(b.conversationId, 'tell me the secret');
    await waitForIdle(h.controller);

    const promptA = JSON.stringify(h.engine.prompts[0]);
    const promptB = JSON.stringify(h.engine.prompts[1]);
    expect(promptA).toContain('SECRET-SENTINEL-7781');
    expect(promptB).not.toContain('SECRET-SENTINEL');
    // Session memory is reset before every generation; weights stay loaded.
    const order = h.engine.events.filter(e => e === 'reset' || e.startsWith('generate:'));
    expect(order.map(e => e.split(':')[0])).toEqual(['reset', 'generate', 'reset', 'generate']);
    expect(h.engine.loadCount).toBe(1);
  });
});

describe('T18 retry then next turn (CHAT-004)', () => {
  it('feeds exactly one selected attempt into later context', async () => {
    h.engine.script.tokens = ['FIRST-ATTEMPT'];
    const first = await h.controller.send(null, 'question');
    await waitForIdle(h.controller);
    if (!first.accepted) {
      throw new Error('not accepted');
    }
    h.engine.script.tokens = ['SECOND-ATTEMPT'];
    const retry = await h.controller.retry(first.conversationId, first.turnId);
    expect(retry.accepted).toBe(true);
    await waitForIdle(h.controller);
    // The retry prompt must not contain the previous attempt of the same turn.
    expect(JSON.stringify(h.engine.prompts[1])).not.toContain('FIRST-ATTEMPT');
    expect(h.engine.prompts[1]!.filter(m => m.role === 'user')).toHaveLength(1);

    h.engine.script.tokens = ['third'];
    await h.controller.send(first.conversationId, 'follow up');
    await waitForIdle(h.controller);
    const prompt = h.engine.prompts[2]!;
    expect(prompt.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(prompt[2]!.content).toBe('SECOND-ATTEMPT');
    expect(JSON.stringify(prompt)).not.toContain('FIRST-ATTEMPT');
  });
});

describe('T19 huge paste / budget overflow (CTX-002)', () => {
  it('refuses more than 12,000 code points without loading the model', async () => {
    const outcome = await h.controller.send(null, '😀'.repeat(12001));
    expect(outcome).toEqual({accepted: false, code: 'INPUT_TOO_LONG'});
    expect(h.engine.loadCount).toBe(0);
  });

  it('refuses a message whose formatted prompt exceeds 1,632 tokens and never truncates it', async () => {
    const outcome = await h.controller.send(null, 'word '.repeat(2300)); // 11,500 code points ≈ 2,900 tokens
    expect(outcome).toEqual({accepted: false, code: 'INPUT_TOO_LONG'});
    expect((await h.t.db.read('SELECT COUNT(*) AS n FROM turns')).rows[0]).toEqual({n: 0});
    expect(h.engine.prompts).toHaveLength(0);
    await waitForIdle(h.controller);
    expect(h.controller.getState().lastError?.code).toBe('INPUT_TOO_LONG');
  });

  it('drops the oldest pairs first and flags the quiet trimmed notice (CTX-003, CTX-004)', async () => {
    let conversationId: string | null = null;
    for (let i = 1; i <= 12; i++) {
      conversationId = (await completedTurn(h.t, conversationId, `Q${i} ` + 'a'.repeat(400), `A${i} ` + 'b'.repeat(400), i * 10)).conversationId;
    }
    let trimmed = false;
    h.controller.subscribe(s => {
      trimmed = trimmed || s.active?.contextTrimmed === true;
    });
    await h.controller.send(conversationId, 'latest question');
    await waitForIdle(h.controller);
    const prompt = h.engine.prompts[0]!;
    const users = prompt.filter(m => m.role === 'user').map(m => m.content.split(' ')[0]);
    expect(users[users.length - 1]).toBe('latest');
    expect(users).toContain('Q12'); // newest kept
    expect(users).not.toContain('Q1'); // oldest dropped
    // Pairs stay complete and contiguous: no isolated assistant, no duplicate user turns.
    const roles = prompt.map(m => m.role).join(',');
    expect(roles).toMatch(/^system(,user,assistant)*,user$/);
    expect(trimmed).toBe(true);
    // Full history is still in SQLite.
    expect((await h.t.db.read('SELECT COUNT(*) AS n FROM turns')).rows[0]).toEqual({n: 13});
  });
});

describe('lifecycle (INF-007, INF-008, MEMORY_LOW)', () => {
  it('on background: checkpoints, interrupts, then unloads after acknowledgement', async () => {
    h.engine.script.tokenDelayMs = 5;
    const outcome = await h.controller.send(null, 'q');
    await sleep(14);
    h.controller.onBackground();
    await waitForIdle(h.controller);
    if (outcome.accepted) {
      expect(await attemptRow(outcome.attemptId)).toMatchObject({
        status: 'interrupted', finish_reason: 'interrupted', error_code: 'ANSWER_INTERRUPTED',
      });
    }
    const cancelAt = h.engine.events.findIndex(e => e.startsWith('cancel:'));
    const unloadAt = h.engine.events.indexOf('unload');
    expect(cancelAt).toBeGreaterThan(-1);
    expect(unloadAt).toBeGreaterThan(cancelAt);
  });

  it('on critical memory pressure: stops with MEMORY_LOW and unloads', async () => {
    h.engine.script.tokenDelayMs = 5;
    const outcome = await h.controller.send(null, 'q');
    await sleep(14);
    h.controller.onMemoryPressure('critical');
    await waitForIdle(h.controller);
    if (outcome.accepted) {
      expect((await attemptRow(outcome.attemptId)).error_code).toBe('MEMORY_LOW');
    }
    expect(h.engine.state()).toBe('unloaded');
    expect(h.controller.getState().lastError?.code).toBe('MEMORY_LOW');
  });

  it('on severe thermal state: stops, unloads and blocks until 30 s of non-severe readings', async () => {
    h.engine.script.tokenDelayMs = 5;
    const outcome = await h.controller.send(null, 'q');
    await sleep(14);
    h.controller.onThermalState('serious');
    await waitForIdle(h.controller);
    if (outcome.accepted) {
      expect((await attemptRow(outcome.attemptId)).error_code).toBe('DEVICE_HOT');
    }
    expect(h.engine.state()).toBe('unloaded');
    expect(await h.controller.send(null, 'again')).toEqual({accepted: false, code: 'DEVICE_HOT'});

    h.controller.onThermalState('fair');
    h.timers.advance(20_000);
    h.controller.onThermalState('critical'); // heat returns: recovery window restarts
    h.controller.onThermalState('nominal');
    h.timers.advance(29_999);
    expect(h.controller.getState().blocked).toBe('DEVICE_HOT');
    h.timers.advance(1);
    expect(h.controller.getState().blocked).toBeNull();
  });

  it('unloads after 120 s of foreground inactivity', async () => {
    await h.controller.send(null, 'q');
    await waitForIdle(h.controller);
    expect(h.engine.state()).toBe('ready');
    h.timers.advance(119_999);
    await sleep(2);
    expect(h.engine.state()).toBe('ready');
    h.timers.advance(1);
    await sleep(2);
    expect(h.engine.state()).toBe('unloaded');
  });

  it('quiesce stops the answer and unloads before activation or deletion (DL-011, T22)', async () => {
    h.engine.script.tokenDelayMs = 5;
    await h.controller.send(null, 'q');
    await sleep(12);
    expect(await h.controller.quiesce()).toBe(true);
    expect(h.engine.state()).toBe('unloaded');
    expect(h.controller.getState().active).toBeNull();
  });
});

describe('STORAGE_WRITE_FAILED', () => {
  it('stops inference and keeps unsaved text visible for Copy without labelling it saved', async () => {
    const big = 'y'.repeat(600);
    h.engine.script.tokens = [big, big, big, big, big, big];
    h.engine.script.tokenDelayMs = 5;
    const outcome = await h.controller.send(null, 'q');
    if (!outcome.accepted) {
      throw new Error('not accepted');
    }
    await sleep(8); // streaming has started; the next checkpoint write will fail
    h.t.driver.faults.failOn = 'UPDATE assistant_attempts';
    await waitForIdle(h.controller);
    h.t.driver.faults.failOn = undefined;
    const state = h.controller.getState();
    expect(state.lastError?.code).toBe('STORAGE_WRITE_FAILED');
    expect(state.unsaved?.attemptId).toBe(outcome.attemptId);
    expect(state.unsaved!.text.length).toBeGreaterThan(0);
    expect(h.engine.events.some(e => e.startsWith('cancel:'))).toBe(true);
  });
});

describe('review regressions', () => {
  it('honours a Stop that arrives between the durable commit and the native completion', async () => {
    h.engine.script.resetDelayMs = 30; // widen the window: session reset in progress
    const outcome = await h.controller.send(null, 'q');
    expect(outcome.accepted).toBe(true);
    h.controller.stop();
    await waitForIdle(h.controller);
    expect(h.engine.events.filter(e => e.startsWith('generate:'))).toEqual([]);
    expect(h.hooks.filter(x => x.startsWith('terminal:'))).toEqual(['terminal:stopped']);
    expect(h.hooks).not.toContain('success');
    if (outcome.accepted) {
      expect(await attemptRow(outcome.attemptId)).toMatchObject({status: 'stopped', finish_reason: 'cancelled'});
    }
  });

  it('shows Stopping at once when Stop is pressed while the model is still loading', async () => {
    h.engine.script.loadDelayMs = 40;
    const pending = h.controller.send(null, 'q');
    await sleep(5);
    expect(h.controller.getState().active?.phase).toBe('preparing');
    h.controller.stop();
    expect(h.controller.getState().active?.phase).toBe('stopping');
    expect(await pending).toEqual({accepted: false, code: 'CANCELLED'});
    expect((await h.t.db.read('SELECT COUNT(*) AS n FROM turns')).rows[0]).toEqual({n: 0});
  });

  it('never lets a thermal event erase safe mode', async () => {
    const safe = await makeHarness({safeModeAtStart: true});
    safe.controller.onThermalState('critical');
    expect(safe.controller.getState().blocked).toBe('SAFE_MODE');
    safe.controller.onThermalState('nominal');
    safe.timers.advance(30_000);
    expect(safe.controller.getState().blocked).toBe('SAFE_MODE');
    safe.controller.leaveSafeMode();
    expect(safe.controller.getState().blocked).toBeNull();
    await safe.t.db.close();
  });

  it('gives quiesce a deadline while an uninterruptible load is in progress', async () => {
    h.engine.script.loadDelayMs = 200;
    void h.controller.send(null, 'q');
    await sleep(5);
    const pending = h.controller.quiesce();
    await sleep(5);
    h.timers.advance(20_000);
    expect(await pending).toBe(false);
    await waitForIdle(h.controller);
  });
});
