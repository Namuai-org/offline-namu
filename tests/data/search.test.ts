import {compileFtsQuery} from '../../src/data/search/ftsQuery';
import {GENERATION, completedTurn, openTestChatDb, sendIds, type TestChatDb} from '../support/chatDb';

let t: TestChatDb;
beforeEach(async () => {
  t = await openTestChatDb();
});
afterEach(async () => {
  await t.db.close();
});

describe('DB-005 literal FTS queries', () => {
  it('requires two characters', () => {
    expect(compileFtsQuery('a')).toBeNull();
    expect(compileFtsQuery(' ƙ ')).toBeNull();
    expect(compileFtsQuery('ƙa')).toBe('"ƙa"*');
  });

  it('quotes every term so FTS syntax is matched as text', () => {
    expect(compileFtsQuery('foo OR bar')).toBe('"foo" "OR" "bar"*');
    expect(compileFtsQuery('say "hi" NEAR(x)')).toBe('"say" """hi""" "NEAR(x)"*');
    expect(compileFtsQuery('body: secret*')).toBe('"body:" "secret*"*');
  });

  it('never throws or changes shape for hostile input', async () => {
    await completedTurn(t, null, 'plain question', 'plain answer', 10);
    for (const hostile of ['" OR 1=1 --', 'NOT', '(((', '*', 'a" b', "'; DROP TABLE turns; --", 'x AND', '^^', '-- -']) {
      await expect(t.search.search(hostile)).resolves.toBeDefined();
    }
    const {rows} = await t.db.read('SELECT COUNT(*) AS n FROM turns');
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

describe('DB-005 matching fixtures', () => {
  it('matches case-insensitively, including Hausa hooked letters', async () => {
    const r = await completedTurn(t, null, 'Ƙasar Hausa tana da ɗimbin tarihi', 'Ɓangaren Arewa', 10);
    for (const q of ['ƙasar', 'ƘASAR', 'ɗimbin', 'ɓangaren', 'hausa tar']) {
      const hits = await t.search.search(q);
      expect(hits.map(h => h.conversationId)).toContain(r.conversationId);
    }
    // ƙ and k are different letters; stored text is untouched (LOC-002).
    expect(await t.search.search('kasar')).toEqual([]);
    const turn = await t.chat.getTurn(r.turnId);
    expect(turn?.userText).toBe('Ƙasar Hausa tana da ɗimbin tarihi');
  });

  it('handles apostrophes and accents in French and Hausa', async () => {
    const fr = await completedTurn(t, null, 'Où est l’école de l\'enfant ?', 'Près de l’église.', 10);
    const ha = await completedTurn(t, null, "Na'am, ina son ruwa", 'To, madalla.', 20);
    expect((await t.search.search("l'école")).map(h => h.conversationId)).toContain(fr.conversationId);
    expect((await t.search.search('l’école')).map(h => h.conversationId)).toContain(fr.conversationId);
    expect((await t.search.search('ecole')).map(h => h.conversationId)).toContain(fr.conversationId);
    expect((await t.search.search('église')).map(h => h.kind)).toContain('assistant');
    expect((await t.search.search("na'am")).map(h => h.conversationId)).toContain(ha.conversationId);
    expect((await t.search.search('naʼam')).map(h => h.conversationId)).toContain(ha.conversationId);
  });

  it('opens the matching turn: hits carry the turn ordinal', async () => {
    const first = await completedTurn(t, null, 'alpha', 'one', 10);
    await completedTurn(t, first.conversationId, 'beta needle', 'two', 20);
    const hits = await t.search.search('needle');
    expect(hits[0]).toMatchObject({conversationId: first.conversationId, ordinal: 2, kind: 'user'});
  });

  it('indexes titles and follows renames', async () => {
    const r = await completedTurn(t, null, 'original words', 'x', 10);
    await t.conversations.rename(r.conversationId, 'Shirin tafiya Kano');
    expect((await t.search.search('kano')).some(h => h.kind === 'title')).toBe(true);
    expect((await t.search.search('original')).some(h => h.kind === 'title')).toBe(false);
  });

  it('does not index streamed tokens, only terminal selected text (DB-004)', async () => {
    const sent = await t.chat.send({
      conversationId: null, userText: 'question', defaultResponseLanguage: 'auto',
      generation: GENERATION, ids: sendIds(), now: 1,
    });
    await t.chat.markStreaming(sent.attemptId, 5, 2);
    await t.chat.checkpoint(sent.attemptId, 'streamingword partial', 3);
    expect(await t.search.search('streamingword')).toEqual([]);
    await t.chat.finishAttempt({
      attemptId: sent.attemptId, status: 'complete', finishReason: 'eos', content: 'streamingword finished',
      promptTokens: 5, outputTokens: 2, errorCode: null, now: 4,
    });
    expect(await t.search.search('streamingword')).toHaveLength(1);
  });

  it('returns at most 50 results per page', async () => {
    let conversationId: string | null = null;
    for (let i = 0; i < 60; i++) {
      conversationId = (await completedTurn(t, conversationId, `common term ${i}`, 'reply', i)).conversationId;
    }
    expect(await t.search.search('common')).toHaveLength(50);
    expect(await t.search.search('common', 1)).toHaveLength(11); // 60 user rows + 1 title row
  });
});
