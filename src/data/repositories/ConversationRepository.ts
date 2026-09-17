import {Database, DomainRuleError} from '../Database';
import type {SqlRow} from '../driver';
import {indexTitle} from '../search/searchIndex';
import type {Conversation, ConversationListItem, ResponseLanguage} from '../types';

export const CONVERSATION_PAGE_SIZE = 30;
const PREVIEW_SOURCE_CHARS = 200;

export interface ConversationCursor {
  updatedAt: number;
  id: string;
}

export function mapConversation(row: SqlRow): Conversation {
  return {
    id: String(row.id),
    title: String(row.title),
    titleIsCustom: Number(row.title_is_custom) === 1,
    responseLanguage: String(row.response_language) as ResponseLanguage,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class ConversationRepository {
  constructor(private readonly db: Database) {}

  /** DB-004: keyset pages of 30 on (updated_at, id), newest first. */
  async listPage(cursor: ConversationCursor | null, limit = CONVERSATION_PAGE_SIZE): Promise<ConversationListItem[]> {
    const where = cursor ? 'WHERE (c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))' : '';
    const params = cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id, limit] : [limit];
    const {rows} = await this.db.read(
      `SELECT c.*,
         (SELECT substr(COALESCE(
                   (SELECT NULLIF(a.content, '') FROM assistant_attempts a WHERE a.id = t.selected_attempt_id),
                   t.user_text), 1, ${PREVIEW_SOURCE_CHARS})
          FROM turns t WHERE t.conversation_id = c.id ORDER BY t.ordinal DESC LIMIT 1) AS preview
       FROM conversations c ${where}
       ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
      params,
    );
    return rows.map(row => ({...mapConversation(row), preview: String(row.preview ?? '')}));
  }

  async get(id: string): Promise<Conversation | null> {
    const {rows} = await this.db.read('SELECT * FROM conversations WHERE id = ?', [id]);
    return rows[0] ? mapConversation(rows[0]) : null;
  }

  async count(): Promise<number> {
    const {rows} = await this.db.read('SELECT COUNT(*) AS n FROM conversations');
    return Number(rows[0]!.n);
  }

  /** A user rename overrides the generated title permanently (CHAT-007). */
  rename(id: string, title: string): Promise<void> {
    return this.db.write(async tx => {
      const result = await tx.execute(
        'UPDATE conversations SET title = ?, title_is_custom = 1 WHERE id = ?',
        [title, id],
      );
      if (result.rowsAffected === 0) {
        throw new DomainRuleError('conversation-missing');
      }
      await indexTitle(tx, id, title);
    });
  }

  /** CTX-006: affects the next answer only. */
  setResponseLanguage(id: string, language: ResponseLanguage): Promise<void> {
    return this.db.write(async tx => {
      await tx.execute('UPDATE conversations SET response_language = ? WHERE id = ?', [language, id]);
    });
  }

  /**
   * DB-002: cascade removes turns, attempts, generations and index rows; the
   * draft is cleared in the same transaction. Callers must have stopped any
   * generation owned by this conversation first (S05).
   */
  delete(id: string): Promise<void> {
    return this.db.write(async tx => {
      const active = await tx.execute(
        `SELECT 1 FROM assistant_attempts a JOIN turns t ON t.id = a.turn_id
         WHERE t.conversation_id = ? AND a.status IN ('pending','streaming','stopping') LIMIT 1`,
        [id],
      );
      if (active.rows.length > 0) {
        throw new DomainRuleError('generation-active');
      }
      await tx.execute('DELETE FROM conversations WHERE id = ?', [id]);
      await tx.execute('DELETE FROM drafts WHERE draft_key = ?', [id]);
    });
  }

  /** SEC-006: conversations, attempts, drafts and search index; settings survive. */
  deleteAll(): Promise<void> {
    return this.db.write(async tx => {
      // Index first so the per-row cascade trigger has nothing left to do.
      await tx.execute('DELETE FROM search_index');
      await tx.execute('DELETE FROM search_rows');
      await tx.execute('DELETE FROM conversations');
      await tx.execute('DELETE FROM drafts');
    });
  }
}
