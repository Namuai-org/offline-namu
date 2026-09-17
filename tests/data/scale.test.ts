import {buildHistoryFixture, percentile} from '../../benchmarks/historyFixture';
import {openTestChatDb, type TestChatDb} from '../support/chatDb';

/**
 * NFR-010 regression guard on the development machine. This is NOT device
 * evidence (OBS-003): release numbers come from benchmarks/ on the qualified
 * device matrix.
 */
describe('NFR-010 history scale (1,000 conversations / 10,000 messages)', () => {
  let t: TestChatDb;
  beforeAll(async () => {
    t = await openTestChatDb();
    await buildHistoryFixture(t.db);
  }, 120000);
  afterAll(async () => {
    await t.db.close();
  });

  it('holds the fixture', async () => {
    const {rows} = await t.db.read(
      'SELECT (SELECT COUNT(*) FROM conversations) AS c, (SELECT COUNT(*) FROM turns) + (SELECT COUNT(*) FROM assistant_attempts) AS m',
    );
    expect(rows[0]).toEqual({c: 1000, m: 10000});
  });

  it('searches with P95 ≤ 500 ms', async () => {
    const queries = ['ruwa', 'ƙasa mak', 'école', "l'eau", 'battery sto', 'harvest family', 'ɗalibi', 'santé', 'wea', 'gida'];
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const start = performance.now();
      const hits = await t.search.search(queries[i % queries.length]!);
      samples.push(performance.now() - start);
      expect(hits.length).toBeGreaterThan(0);
    }
    expect(percentile(samples, 95)).toBeLessThanOrEqual(500);
  });

  it('opens paginated lists with P95 ≤ 500 ms', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const start = performance.now();
      const page = await t.conversations.listPage(null);
      const turns = await t.chat.getTurnsBefore(page[i % page.length]!.id, null);
      samples.push(performance.now() - start);
      expect(turns.length).toBe(5);
    }
    expect(percentile(samples, 95)).toBeLessThanOrEqual(500);
  });
});
