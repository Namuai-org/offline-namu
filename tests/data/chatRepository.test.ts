import {DomainRuleError, StorageWriteError} from '../../src/data/Database';
import {NEW_CHAT_DRAFT_KEY} from '../../src/data/repositories/DraftRepository';
import {GENERATION, completedTurn, nextId, openTestChatDb, sendIds, type TestChatDb} from '../support/chatDb';

let t: TestChatDb;
beforeEach(async () => {
  t = await openTestChatDb();
});
afterEach(async () => {
  await t.db.close();
});

async function count(table: string): Promise<number> {
  const {rows} = await t.db.read(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rows[0]!.n);
}

describe('CHAT-001 send transaction', () => {
  it('creates conversation, turn, attempt, generation and clears the new-chat draft atomically', async () => {
    await t.drafts.save(NEW_CHAT_DRAFT_KEY, 'Sannu Namu', 5);
    const sent = await t.chat.send({
      conversationId: null,
      userText: 'Sannu Namu,\nyaya kake?',
      defaultResponseLanguage: 'ha',
      generation: GENERATION,
      ids: sendIds(),
      now: 100,
    });
    expect(sent.isNewConversation).toBe(true);
    expect(sent.ordinal).toBe(1);
    expect(sent.conversation.title).toBe('Sannu Namu, yaya kake?');
    expect(sent.conversation.responseLanguage).toBe('ha');
    expect(await count('conversations')).toBe(1);
    expect(await count('turns')).toBe(1);
    expect(await count('assistant_attempts')).toBe(1);
    expect(await count('generations')).toBe(1);
    expect(await t.drafts.get(NEW_CHAT_DRAFT_KEY)).toBe('');
    const turn = await t.chat.getTurn(sent.turnId);
    expect(turn?.displayAttempt?.status).toBe('pending');
    expect(turn?.selectedAttemptId).toBeNull();
  });

  it('leaves the draft and every table unchanged when the transaction fails', async () => {
    await t.drafts.save(NEW_CHAT_DRAFT_KEY, 'unsent text', 5);
    t.driver.faults.failOn = 'INSERT INTO generations';
    await expect(
      t.chat.send({
        conversationId: null,
        userText: 'unsent text',
        defaultResponseLanguage: 'auto',
        generation: GENERATION,
        ids: sendIds(),
        now: 100,
      }),
    ).rejects.toBeInstanceOf(StorageWriteError);
    t.driver.faults.failOn = undefined;
    expect(await count('conversations')).toBe(0);
    expect(await count('turns')).toBe(0);
    expect(await count('assistant_attempts')).toBe(0);
    expect(await count('search_rows')).toBe(0);
    expect(await t.drafts.get(NEW_CHAT_DRAFT_KEY)).toBe('unsent text');
  });

  it('truncates generated titles to 48 grapheme clusters without splitting clusters (CHAT-007)', async () => {
    const family = '👨‍👩‍👧‍👦';
    const text = `${family.repeat(60)} ƙarshe`;
    const sent = await t.chat.send({
      conversationId: null, userText: text, defaultResponseLanguage: 'auto',
      generation: GENERATION, ids: sendIds(), now: 1,
    });
    expect(sent.conversation.title.startsWith(family)).toBe(true);
    expect(sent.conversation.title.endsWith(family)).toBe(true);
    expect(sent.conversation.title).toBe(family.repeat(48));
  });

  it('rejects a second send while an attempt is active in the conversation (T14)', async () => {
    const first = await t.chat.send({
      conversationId: null, userText: 'one', defaultResponseLanguage: 'auto',
      generation: GENERATION, ids: sendIds(), now: 1,
    });
    await expect(
      t.chat.send({
        conversationId: first.conversation.id, userText: 'two', defaultResponseLanguage: 'auto',
        generation: GENERATION, ids: sendIds(), now: 2,
      }),
    ).rejects.toBeInstanceOf(DomainRuleError);
    expect(await count('turns')).toBe(1);
  });

  it('orders turns by ordinal independent of the clock (DB-002)', async () => {
    const a = await completedTurn(t, null, 'first', 'A', 5000);
    await completedTurn(t, a.conversationId, 'second', 'B', 10); // clock moved backwards
    const turns = await t.chat.getTurnsBefore(a.conversationId, null);
    expect(turns.map(x => x.userText)).toEqual(['second', 'first']);
  });
});

describe('CHAT-003 guarded terminal transitions', () => {
  it('ends an attempt exactly once; a late completion cannot overwrite a stop', async () => {
    const sent = await t.chat.send({
      conversationId: null, userText: 'q', defaultResponseLanguage: 'auto',
      generation: GENERATION, ids: sendIds(), now: 1,
    });
    await t.chat.markStreaming(sent.attemptId, 12, 2);
    await t.chat.checkpoint(sent.attemptId, 'partial', 3);
    expect(await t.chat.markStopping(sent.attemptId, 4)).toBe(true);
    const stopped = await t.chat.finishAttempt({
      attemptId: sent.attemptId, status: 'stopped', finishReason: 'cancelled',
      content: 'partial', promptTokens: 12, outputTokens: 2, errorCode: null, now: 5,
    });
    expect(stopped).toEqual({applied: true, selected: true});
    const late = await t.chat.finishAttempt({
      attemptId: sent.attemptId, status: 'complete', finishReason: 'eos',
      content: 'partial and then the full answer', promptTokens: 12, outputTokens: 9, errorCode: null, now: 6,
    });
    expect(late.applied).toBe(false);
    expect(await t.chat.checkpoint(sent.attemptId, 'late checkpoint', 7)).toBe(false);
    const turn = await t.chat.getTurn(sent.turnId);
    expect(turn?.displayAttempt?.status).toBe('stopped');
    expect(turn?.displayAttempt?.content).toBe('partial');
  });

  it('marks in-flight attempts interrupted on restart and never re-executes (T16)', async () => {
    const sent = await t.chat.send({
      conversationId: null, userText: 'will be killed', defaultResponseLanguage: 'auto',
      generation: GENERATION, ids: sendIds(), now: 1,
    });
    await t.chat.markStreaming(sent.attemptId, 8, 2);
    await t.chat.checkpoint(sent.attemptId, 'half an ans', 3);
    // process death here; next launch:
    expect(await t.chat.recoverInterruptedAttempts(50)).toBe(1);
    const turn = await t.chat.getTurn(sent.turnId);
    expect(turn?.userText).toBe('will be killed');
    expect(turn?.displayAttempt?.status).toBe('interrupted');
    expect(turn?.displayAttempt?.content).toBe('half an ans');
    expect(turn?.selectedAttemptId).toBe(sent.attemptId);
    const {rows} = await t.db.read('SELECT error_code, ended_at FROM generations WHERE attempt_id = ?', [sent.attemptId]);
    expect(rows[0]).toEqual({error_code: 'ANSWER_INTERRUPTED', ended_at: 50});
    expect(await t.chat.recoverInterruptedAttempts(60)).toBe(0);
  });
});

describe('CHAT-004 / CHAT-005 retry and selection', () => {
  it('keeps the old selection when a retry fails empty, selects a non-empty retry', async () => {
    const first = await completedTurn(t, null, 'question', 'first answer', 10);
    const retry1 = await t.chat.createRetryAttempt({
      turnId: first.turnId, generation: GENERATION,
      ids: {attemptId: nextId('att'), generationId: nextId('gen')}, now: 20,
    });
    expect(retry1.attemptNumber).toBe(2);
    await t.chat.finishAttempt({
      attemptId: retry1.attemptId, status: 'failed', finishReason: 'error', content: '',
      promptTokens: null, outputTokens: 0, errorCode: 'MODEL_LOAD_FAILED', now: 21,
    });
    expect((await t.chat.getTurn(first.turnId))?.selectedAttemptId).toBe(first.attemptId);

    const retry2 = await t.chat.createRetryAttempt({
      turnId: first.turnId, generation: GENERATION,
      ids: {attemptId: nextId('att'), generationId: nextId('gen')}, now: 30,
    });
    await t.chat.finishAttempt({
      attemptId: retry2.attemptId, status: 'complete', finishReason: 'eos', content: 'better answer',
      promptTokens: 9, outputTokens: 3, errorCode: null, now: 31,
    });
    const turn = await t.chat.getTurn(first.turnId);
    expect(turn?.selectedAttemptId).toBe(retry2.attemptId);
    expect(turn?.attemptCount).toBe(3);
    expect((await t.chat.getAttempts(first.turnId)).map(a => a.attemptNumber)).toEqual([3, 2, 1]);
  });

  it('only the selected attempt enters later context (T18)', async () => {
    const first = await completedTurn(t, null, 'question', 'OLD-ANSWER', 10);
    const retry = await t.chat.createRetryAttempt({
      turnId: first.turnId, generation: GENERATION,
      ids: {attemptId: nextId('att'), generationId: nextId('gen')}, now: 20,
    });
    await t.chat.finishAttempt({
      attemptId: retry.attemptId, status: 'complete', finishReason: 'eos', content: 'NEW-ANSWER',
      promptTokens: 9, outputTokens: 3, errorCode: null, now: 21,
    });
    const next = await t.chat.send({
      conversationId: first.conversationId, userText: 'follow up', defaultResponseLanguage: 'auto',
      generation: GENERATION, ids: sendIds(), now: 30,
    });
    const pairs = await t.chat.getContextPairs(first.conversationId, next.ordinal, 30, 0);
    expect(pairs).toEqual([{ordinal: 1, userText: 'question', assistantText: 'NEW-ANSWER'}]);
  });

  it('refuses retry and re-selection once a newer turn exists', async () => {
    const first = await completedTurn(t, null, 'one', 'A', 10);
    await completedTurn(t, first.conversationId, 'two', 'B', 20);
    await expect(
      t.chat.createRetryAttempt({
        turnId: first.turnId, generation: GENERATION,
        ids: {attemptId: nextId('att'), generationId: nextId('gen')}, now: 30,
      }),
    ).rejects.toMatchObject({rule: 'not-latest-turn'});
    await expect(t.chat.selectAttempt(first.turnId, first.attemptId)).rejects.toMatchObject({
      rule: 'selection-read-only',
    });
  });

  it('skips turns without a usable selected answer so roles never duplicate (CTX-003)', async () => {
    const a = await completedTurn(t, null, 'kept', 'kept answer', 10);
    const failed = await t.chat.send({
      conversationId: a.conversationId, userText: 'failed empty', defaultResponseLanguage: 'auto',
      generation: GENERATION, ids: sendIds(), now: 20,
    });
    await t.chat.finishAttempt({
      attemptId: failed.attemptId, status: 'failed', finishReason: 'error', content: '',
      promptTokens: null, outputTokens: 0, errorCode: 'MEMORY_LOW', now: 21,
    });
    const partial = await t.chat.send({
      conversationId: a.conversationId, userText: 'stopped early', defaultResponseLanguage: 'auto',
      generation: GENERATION, ids: sendIds(), now: 30,
    });
    await t.chat.finishAttempt({
      attemptId: partial.attemptId, status: 'stopped', finishReason: 'cancelled', content: 'partial text',
      promptTokens: 5, outputTokens: 2, errorCode: null, now: 31,
    });
    const pairs = await t.chat.getContextPairs(a.conversationId, 99, 30, 0);
    expect(pairs.map(p => p.userText)).toEqual(['stopped early', 'kept']);
  });
});

describe('DB-002 integrity', () => {
  it('rejects selecting an attempt that belongs to another turn', async () => {
    const a = await completedTurn(t, null, 'a', 'A', 10);
    const b = await completedTurn(t, null, 'b', 'B', 20);
    await expect(
      t.db.write(tx => tx.execute('UPDATE turns SET selected_attempt_id = ? WHERE id = ?', [b.attemptId, a.turnId])),
    ).rejects.toBeInstanceOf(StorageWriteError);
    expect((await t.chat.getTurn(a.turnId))?.selectedAttemptId).toBe(a.attemptId);
  });

  it('clears the selection when the selected attempt is deleted', async () => {
    const a = await completedTurn(t, null, 'a', 'A', 10);
    await t.db.write(tx => tx.execute('DELETE FROM assistant_attempts WHERE id = ?', [a.attemptId]));
    expect((await t.chat.getTurn(a.turnId))?.selectedAttemptId).toBeNull();
  });

  it('deletes a conversation by cascade, clears its draft and index rows', async () => {
    const a = await completedTurn(t, null, 'remove me', 'gone', 10);
    const keep = await completedTurn(t, null, 'keep me', 'stays', 20);
    await t.drafts.save(a.conversationId, 'draft', 30);
    await t.conversations.delete(a.conversationId);
    expect(await count('conversations')).toBe(1);
    expect(await count('turns')).toBe(1);
    expect(await count('assistant_attempts')).toBe(1);
    expect(await count('generations')).toBe(1);
    expect(await t.drafts.get(a.conversationId)).toBe('');
    expect(await t.search.search('remove')).toEqual([]);
    expect((await t.search.search('keep')).map(h => h.conversationId)).toEqual([keep.conversationId, keep.conversationId]);
  });

  it('refuses to delete a conversation with an active generation (S05, T22)', async () => {
    const sent = await t.chat.send({
      conversationId: null, userText: 'active', defaultResponseLanguage: 'auto',
      generation: GENERATION, ids: sendIds(), now: 1,
    });
    await expect(t.conversations.delete(sent.conversation.id)).rejects.toMatchObject({rule: 'generation-active'});
    expect(await count('conversations')).toBe(1);
  });

  it('delete-all removes chats, drafts and index but preserves preferences (SEC-006)', async () => {
    await completedTurn(t, null, 'x', 'y', 10);
    await t.drafts.save(NEW_CHAT_DRAFT_KEY, 'd', 11);
    await t.preferences.set('theme', 'dark');
    await t.conversations.deleteAll();
    expect(await count('conversations')).toBe(0);
    expect(await count('drafts')).toBe(0);
    expect(await count('search_rows')).toBe(0);
    expect(await count('search_index')).toBe(0);
    expect((await t.preferences.load(['en-US'])).theme).toBe('dark');
  });
});

describe('DB-004 pagination', () => {
  it('pages conversations by keyset and turns by ordinal in pages of 30', async () => {
    let conversationId: string | null = null;
    for (let i = 1; i <= 65; i++) {
      const r = await completedTurn(t, conversationId, `message ${i}`, `answer ${i}`, i * 10);
      conversationId = r.conversationId;
    }
    const page1 = await t.chat.getTurnsBefore(conversationId!, null);
    expect(page1).toHaveLength(30);
    expect(page1[0]!.ordinal).toBe(65);
    const page2 = await t.chat.getTurnsBefore(conversationId!, page1[29]!.ordinal);
    expect(page2[0]!.ordinal).toBe(35);
    const newer = await t.chat.getTurnsAfter(conversationId!, 35);
    expect(newer[0]!.ordinal).toBe(36);

    for (let i = 0; i < 40; i++) {
      await completedTurn(t, null, `conv ${i}`, 'ok', 1000 + (i % 3)); // deliberate timestamp ties
    }
    const first = await t.conversations.listPage(null);
    expect(first).toHaveLength(30);
    const last = first[29]!;
    const second = await t.conversations.listPage({updatedAt: last.updatedAt, id: last.id});
    const ids = new Set([...first, ...second].map(c => c.id));
    expect(ids.size).toBe(41);
    expect(first[0]!.preview.length).toBeGreaterThan(0);
  });
});
