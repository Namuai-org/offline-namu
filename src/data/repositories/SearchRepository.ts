import type {Database} from '../Database';
import {compileFtsQuery} from '../search/ftsQuery';
import type {SearchHit} from '../types';

export const SEARCH_PAGE_SIZE = 50;

/** DB-005: local FTS5 search, at most 50 results per page. */
export class SearchRepository {
  constructor(private readonly db: Database) {}

  async search(input: string, page = 0): Promise<SearchHit[]> {
    const match = compileFtsQuery(input);
    if (match === null) {
      return [];
    }
    const {rows} = await this.db.read(
      `SELECT r.conversation_id, r.turn_id, r.kind, c.title, c.updated_at, t.ordinal,
              snippet(search_index, 0, '', '', '…', 12) AS snippet
       FROM search_index
       JOIN search_rows r ON r.rowid = search_index.rowid
       JOIN conversations c ON c.id = r.conversation_id
       LEFT JOIN turns t ON t.id = r.turn_id
       WHERE search_index MATCH ?
       ORDER BY bm25(search_index), c.updated_at DESC
       LIMIT ? OFFSET ?`,
      [match, SEARCH_PAGE_SIZE, page * SEARCH_PAGE_SIZE],
    );
    return rows.map(row => ({
      conversationId: String(row.conversation_id),
      conversationTitle: String(row.title),
      turnId: row.turn_id == null ? null : String(row.turn_id),
      ordinal: row.ordinal == null ? null : Number(row.ordinal),
      kind: String(row.kind) as SearchHit['kind'],
      snippet: String(row.snippet ?? ''),
      updatedAt: Number(row.updated_at),
    }));
  }
}
