import type {SqlExecutor} from '../driver';
import {foldForSearch} from './ftsQuery';

/**
 * Index maintenance helpers. Always called inside the transaction that changes
 * the content (DB-004). Streaming tokens are never indexed: assistant text is
 * written here only for a terminal, selected attempt.
 */
export async function indexTitle(tx: SqlExecutor, conversationId: string, title: string): Promise<void> {
  await tx.execute("DELETE FROM search_rows WHERE conversation_id = ? AND kind = 'title'", [
    conversationId,
  ]);
  await tx.execute("INSERT INTO search_rows (conversation_id, turn_id, kind) VALUES (?, NULL, 'title')", [
    conversationId,
  ]);
  await tx.execute(
    `INSERT INTO search_index (rowid, body)
     VALUES ((SELECT rowid FROM search_rows WHERE conversation_id = ? AND kind = 'title'), ?)`,
    [conversationId, foldForSearch(title)],
  );
}

export async function indexTurnText(
  tx: SqlExecutor,
  conversationId: string,
  turnId: string,
  kind: 'user' | 'assistant',
  text: string,
): Promise<void> {
  await tx.execute('DELETE FROM search_rows WHERE turn_id = ? AND kind = ?', [turnId, kind]);
  if (text.length === 0) {
    return;
  }
  await tx.execute('INSERT INTO search_rows (conversation_id, turn_id, kind) VALUES (?, ?, ?)', [
    conversationId,
    turnId,
    kind,
  ]);
  await tx.execute(
    `INSERT INTO search_index (rowid, body)
     VALUES ((SELECT rowid FROM search_rows WHERE turn_id = ? AND kind = ?), ?)`,
    [turnId, kind, foldForSearch(text)],
  );
}
