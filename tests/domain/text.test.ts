import {titleFromFirstMessage, validateRename} from '../../src/domain/chat/title';
import {buildSystemPrompt} from '../../src/domain/chat/systemPrompt';
import {assembleMessages, fitPrompt} from '../../src/domain/chat/promptBudget';
import {codePointLength, splitGraphemes, truncateGraphemes} from '../../src/domain/text/graphemes';
import {approximateTokens} from '../../src/infrastructure/inference/fake/FakeInferenceEngine';

describe('grapheme helpers (Hermes fallback must agree with Intl.Segmenter)', () => {
  const samples = [
    'Ƙasa ɗaya ɓangare ƴaƴa',
    'école l’école',
    '👨‍👩‍👧‍👦 family 👍🏾 flag 🇳🇪🇳🇬',
    'line\r\nbreak',
    '1️⃣ keycap',
  ];
  it.each(samples)('segments %s identically', sample => {
    expect(splitGraphemes(sample, true)).toEqual(splitGraphemes(sample));
  });

  it('never cuts inside a cluster and keeps Hausa letters intact (LOC-002)', () => {
    expect(truncateGraphemes('👍🏾👍🏾👍🏾', 2)).toBe('👍🏾👍🏾');
    expect(truncateGraphemes('ƙƙɗɓ', 3)).toBe('ƙƙɗ');
    expect(codePointLength('😀ƙ')).toBe(2);
  });
});

describe('titles (CHAT-007, S05)', () => {
  it('normalizes to one line and 48 clusters', () => {
    expect(titleFromFirstMessage('  Ina   kwana?\n\nLafiya  lau ')).toBe('Ina kwana? Lafiya lau');
    expect(splitGraphemes(titleFromFirstMessage('x'.repeat(200)))).toHaveLength(48);
  });
  it('validates rename length 1–80 clusters', () => {
    expect(validateRename('   ')).toEqual({ok: false, reason: 'empty'});
    expect(validateRename('🇳🇪'.repeat(81))).toEqual({ok: false, reason: 'tooLong'});
    expect(validateRename('🇳🇪'.repeat(80))).toMatchObject({ok: true});
  });
});

describe('system prompt (CTX-001)', () => {
  it('appends exactly one fixed response-language line', () => {
    expect(buildSystemPrompt('auto').endsWith('\nResponse language: match the latest user message.')).toBe(true);
    expect(buildSystemPrompt('ha').endsWith('\nResponse language: Hausa.')).toBe(true);
    expect(buildSystemPrompt('fr').endsWith('\nResponse language: French.')).toBe(true);
    expect(buildSystemPrompt('en').endsWith('\nResponse language: English.')).toBe(true);
    expect(buildSystemPrompt('en').startsWith('You are Namu, a helpful assistant running on this device.')).toBe(true);
  });
});

describe('prompt budget (CTX-002, CTX-003)', () => {
  const count = async (m: Parameters<typeof approximateTokens>[0]) => approximateTokens(m);
  const pair = (n: number, size: number) => ({ordinal: n, userText: `u${n} ` + 'a'.repeat(size), assistantText: `a${n} ` + 'b'.repeat(size)});

  it('keeps the newest contiguous pairs and orders them oldest to newest', async () => {
    const pairs = [pair(5, 40), pair(4, 40), pair(3, 40), pair(2, 40), pair(1, 40)];
    const fit = await fitPrompt({systemPrompt: 's', currentUserText: 'now', pairsNewestFirst: pairs, moreHistoryAvailable: false, count, ceiling: 110});
    expect(fit.ok).toBe(true);
    if (fit.ok) {
      const users = fit.messages.filter(m => m.role === 'user').map(m => m.content.split(' ')[0]);
      expect(users[users.length - 1]).toBe('now');
      expect(users.slice(0, -1)).toEqual([...users.slice(0, -1)].sort());
      expect(users).toContain('u5');
      expect(users).not.toContain('u1');
      expect(fit.promptTokens).toBeLessThanOrEqual(110);
      expect(fit.trimmed).toBe(true);
      // Adding one more pair would overflow: the fit is maximal.
      const bigger = assembleMessages('s', pairs.slice(0, fit.includedPairs + 1), 'now');
      expect(await count(bigger)).toBeGreaterThan(110);
    }
  });

  it('refuses rather than truncating when the current message alone is too long', async () => {
    const fit = await fitPrompt({systemPrompt: 's', currentUserText: 'x'.repeat(4000), pairsNewestFirst: [pair(1, 10)], moreHistoryAvailable: false, count, ceiling: 500});
    expect(fit).toMatchObject({ok: false, reason: 'INPUT_TOO_LONG'});
  });

  it('reports untrimmed when everything fits', async () => {
    const fit = await fitPrompt({systemPrompt: 's', currentUserText: 'q', pairsNewestFirst: [pair(1, 10)], moreHistoryAvailable: false, count});
    expect(fit).toMatchObject({ok: true, includedPairs: 1, trimmed: false});
  });
});
