import type {Database} from '../src/data/Database';
import {indexTitle, indexTurnText} from '../src/data/search/searchIndex';

/**
 * NFR-001 / NFR-010 workload fixture: 1,000 conversations and 10,000 messages
 * (5,000 user turns + 5,000 answers) of deterministic multilingual text. No
 * real chat logs are used.
 */
const WORDS = [
  'ruwa', 'gida', 'kasuwa', 'ƙasa', 'ɗalibi', 'ɓangare', 'lafiya', 'abinci', 'hanya', 'makaranta',
  'école', 'marché', 'santé', 'maison', 'voyage', 'récolte', 'l’eau', 'famille', 'travail', 'village',
  'water', 'market', 'health', 'school', 'harvest', 'family', 'journey', 'weather', 'battery', 'storage',
];

function sentence(seed: number, length: number): string {
  const parts: string[] = [];
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < length; i++) {
    // 32-bit LCG (Numerical Recipes constants); deterministic across engines.
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    parts.push(WORDS[(x >>> 8) % WORDS.length]!);
  }
  return parts.join(' ');
}

export const FIXTURE_CONVERSATIONS = 1000;
export const FIXTURE_TURNS_PER_CONVERSATION = 5;

export async function buildHistoryFixture(db: Database): Promise<void> {
  await db.write(async tx => {
    for (let c = 0; c < FIXTURE_CONVERSATIONS; c++) {
      const conversationId = `fixture-conv-${c}`;
      const title = sentence(c + 7, 4);
      const base = 1_700_000_000_000 + c * 60_000;
      await tx.execute(
        'INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
        [conversationId, title, base, base + 50_000],
      );
      await indexTitle(tx, conversationId, title);
      for (let n = 1; n <= FIXTURE_TURNS_PER_CONVERSATION; n++) {
        const turnId = `${conversationId}-t${n}`;
        const attemptId = `${turnId}-a1`;
        const userText = sentence(c * 31 + n, 12);
        const answer = sentence(c * 17 + n * 3, 60);
        await tx.execute(
          'INSERT INTO turns (id, conversation_id, ordinal, user_text, created_at) VALUES (?, ?, ?, ?, ?)',
          [turnId, conversationId, n, userText, base + n * 1000],
        );
        await tx.execute(
          `INSERT INTO assistant_attempts (id, turn_id, attempt_number, content, status, finish_reason, created_at, updated_at)
           VALUES (?, ?, 1, ?, 'complete', 'eos', ?, ?)`,
          [attemptId, turnId, answer, base + n * 1000, base + n * 1000 + 500],
        );
        await tx.execute('UPDATE turns SET selected_attempt_id = ? WHERE id = ?', [attemptId, turnId]);
        await indexTurnText(tx, conversationId, turnId, 'user', userText);
        await indexTurnText(tx, conversationId, turnId, 'assistant', answer);
      }
    }
  });
}

export function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}
