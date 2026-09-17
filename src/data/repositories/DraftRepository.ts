import type {Database} from '../Database';

/** DB-003: draft keys are conversation IDs or `new-chat`. */
export const NEW_CHAT_DRAFT_KEY = 'new-chat';
/** CTX-002: draft storage limit in Unicode code points. */
export const DRAFT_MAX_CODE_POINTS = 12000;

export class DraftRepository {
  constructor(private readonly db: Database) {}

  async get(key: string): Promise<string> {
    const {rows} = await this.db.read('SELECT content FROM drafts WHERE draft_key = ?', [key]);
    return rows[0] ? String(rows[0].content) : '';
  }

  save(key: string, content: string, now: number): Promise<void> {
    return this.db.write(async tx => {
      if (content.length === 0) {
        await tx.execute('DELETE FROM drafts WHERE draft_key = ?', [key]);
        return;
      }
      await tx.execute(
        `INSERT INTO drafts (draft_key, content, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(draft_key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
        [key, content, now],
      );
    });
  }
}
