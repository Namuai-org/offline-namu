import {Database, DomainRuleError} from '../Database';
import type {SqlExecutor, SqlRow} from '../driver';
import {indexTitle, indexTurnText} from '../search/searchIndex';
import type {
  Attempt,
  AttemptStatus,
  ContextPair,
  Conversation,
  GenerationRecord,
  ResponseLanguage,
  TerminalAttemptStatus,
  Turn,
} from '../types';
import {titleFromFirstMessage} from '../../domain/chat/title';
import {NEW_CHAT_DRAFT_KEY} from './DraftRepository';
import {mapConversation} from './ConversationRepository';

export const TURN_PAGE_SIZE = 30;
const ACTIVE = "('pending','streaming','stopping')";

export interface SendIds {
  conversationId: string;
  turnId: string;
  attemptId: string;
  generationId: string;
}

export interface SendResult {
  conversation: Conversation;
  isNewConversation: boolean;
  turnId: string;
  ordinal: number;
  attemptId: string;
  generationId: string;
}

export interface FinishInput {
  attemptId: string;
  status: TerminalAttemptStatus;
  finishReason: string;
  content: string;
  promptTokens: number | null;
  outputTokens: number | null;
  errorCode: string | null;
  now: number;
}

function mapAttempt(row: SqlRow, prefix = ''): Attempt {
  return {
    id: String(row[`${prefix}id`]),
    turnId: String(row[`${prefix}turn_id`]),
    attemptNumber: Number(row[`${prefix}attempt_number`]),
    content: String(row[`${prefix}content`] ?? ''),
    status: String(row[`${prefix}status`]) as AttemptStatus,
    finishReason: row[`${prefix}finish_reason`] == null ? null : String(row[`${prefix}finish_reason`]),
    createdAt: Number(row[`${prefix}created_at`]),
    updatedAt: Number(row[`${prefix}updated_at`]),
  };
}

const TURN_SELECT = `
SELECT t.id, t.conversation_id, t.ordinal, t.user_text, t.selected_attempt_id, t.created_at,
       (SELECT COUNT(*) FROM assistant_attempts c WHERE c.turn_id = t.id) AS attempt_count,
       a.id AS a_id, a.turn_id AS a_turn_id, a.attempt_number AS a_attempt_number,
       a.content AS a_content, a.status AS a_status, a.finish_reason AS a_finish_reason,
       a.created_at AS a_created_at, a.updated_at AS a_updated_at
FROM turns t
LEFT JOIN assistant_attempts a ON a.id = COALESCE(
  t.selected_attempt_id,
  (SELECT n.id FROM assistant_attempts n WHERE n.turn_id = t.id
   ORDER BY n.attempt_number DESC LIMIT 1))`;

function mapTurn(row: SqlRow): Turn {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    ordinal: Number(row.ordinal),
    userText: String(row.user_text),
    selectedAttemptId: row.selected_attempt_id == null ? null : String(row.selected_attempt_id),
    createdAt: Number(row.created_at),
    attemptCount: Number(row.attempt_count),
    displayAttempt: row.a_id == null ? null : mapAttempt(row, 'a_'),
  };
}

/**
 * Durable conversation lifecycle (PRD section 11). Every state change is a
 * guarded UPDATE keyed by attempt ID and current status, so a late completion
 * can never overwrite a cancellation or another attempt (CHAT-003).
 */
export class ChatRepository {
  constructor(private readonly db: Database) {}

  /**
   * CHAT-001: one transaction creates the user turn, the first assistant
   * attempt, the generation record, the conversation (when new, CHAT-007) and
   * the timestamp update, and clears the sent draft (DB-003). If it fails the
   * caller's draft is untouched.
   */
  send(input: {
    conversationId: string | null;
    userText: string;
    defaultResponseLanguage: ResponseLanguage;
    generation: GenerationRecord;
    ids: SendIds;
    now: number;
  }): Promise<SendResult> {
    const {ids, now, userText, generation} = input;
    return this.db.write(async tx => {
      let conversation: Conversation;
      const isNew = input.conversationId === null;
      if (isNew) {
        const title = titleFromFirstMessage(userText) || '…';
        await tx.execute(
          `INSERT INTO conversations (id, title, title_is_custom, response_language, created_at, updated_at)
           VALUES (?, ?, 0, ?, ?, ?)`,
          [ids.conversationId, title, input.defaultResponseLanguage, now, now],
        );
        await indexTitle(tx, ids.conversationId, title);
        conversation = {
          id: ids.conversationId,
          title,
          titleIsCustom: false,
          responseLanguage: input.defaultResponseLanguage,
          createdAt: now,
          updatedAt: now,
        };
      } else {
        const found = await tx.execute('SELECT * FROM conversations WHERE id = ?', [input.conversationId]);
        if (found.rows.length === 0) {
          throw new DomainRuleError('conversation-missing');
        }
        conversation = {...mapConversation(found.rows[0]!), updatedAt: now};
        await assertNoActiveAttempt(tx, conversation.id);
      }

      const next = await tx.execute(
        'SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM turns WHERE conversation_id = ?',
        [conversation.id],
      );
      const ordinal = Number(next.rows[0]!.ordinal);
      await tx.execute(
        `INSERT INTO turns (id, conversation_id, ordinal, user_text, selected_attempt_id, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
        [ids.turnId, conversation.id, ordinal, userText, now],
      );
      await insertAttempt(tx, ids.attemptId, ids.turnId, 1, now);
      await insertGeneration(tx, ids.generationId, ids.attemptId, generation, now);
      await tx.execute('UPDATE conversations SET updated_at = ? WHERE id = ?', [now, conversation.id]);
      await indexTurnText(tx, conversation.id, ids.turnId, 'user', userText);
      await tx.execute('DELETE FROM drafts WHERE draft_key = ?', [
        isNew ? NEW_CHAT_DRAFT_KEY : conversation.id,
      ]);
      return {
        conversation,
        isNewConversation: isNew,
        turnId: ids.turnId,
        ordinal,
        attemptId: ids.attemptId,
        generationId: ids.generationId,
      };
    });
  }

  /**
   * CHAT-004: Try again exists only on the latest turn and creates a new
   * attempt for the same user message, preserving old attempts.
   */
  createRetryAttempt(input: {
    turnId: string;
    generation: GenerationRecord;
    ids: {attemptId: string; generationId: string};
    now: number;
  }): Promise<{attemptId: string; generationId: string; attemptNumber: number; conversationId: string}> {
    return this.db.write(async tx => {
      const turn = await tx.execute(
        `SELECT t.conversation_id, t.ordinal,
                (SELECT MAX(ordinal) FROM turns x WHERE x.conversation_id = t.conversation_id) AS latest
         FROM turns t WHERE t.id = ?`,
        [input.turnId],
      );
      const row = turn.rows[0];
      if (!row) {
        throw new DomainRuleError('turn-missing');
      }
      if (Number(row.ordinal) !== Number(row.latest)) {
        throw new DomainRuleError('not-latest-turn');
      }
      const conversationId = String(row.conversation_id);
      await assertNoActiveAttempt(tx, conversationId);
      const next = await tx.execute(
        'SELECT COALESCE(MAX(attempt_number), 0) + 1 AS n FROM assistant_attempts WHERE turn_id = ?',
        [input.turnId],
      );
      const attemptNumber = Number(next.rows[0]!.n);
      await insertAttempt(tx, input.ids.attemptId, input.turnId, attemptNumber, input.now);
      await insertGeneration(tx, input.ids.generationId, input.ids.attemptId, input.generation, input.now);
      await tx.execute('UPDATE conversations SET updated_at = ? WHERE id = ?', [input.now, conversationId]);
      return {...input.ids, attemptNumber, conversationId};
    });
  }

  async markStreaming(attemptId: string, promptTokens: number | null, now: number): Promise<boolean> {
    return this.db.write(async tx => {
      const result = await tx.execute(
        "UPDATE assistant_attempts SET status = 'streaming', updated_at = ? WHERE id = ? AND status = 'pending'",
        [now, attemptId],
      );
      if (result.rowsAffected > 0 && promptTokens !== null) {
        await tx.execute('UPDATE generations SET prompt_tokens = ? WHERE attempt_id = ?', [
          promptTokens,
          attemptId,
        ]);
      }
      return result.rowsAffected > 0;
    });
  }

  /** CHAT-002 periodic checkpoint; ignored once the attempt is terminal. */
  checkpoint(attemptId: string, content: string, now: number): Promise<boolean> {
    return this.db.write(async tx => {
      const result = await tx.execute(
        `UPDATE assistant_attempts SET content = ?, updated_at = ?
         WHERE id = ? AND status IN ${ACTIVE}`,
        [content, now, attemptId],
      );
      return result.rowsAffected > 0;
    });
  }

  markStopping(attemptId: string, now: number): Promise<boolean> {
    return this.db.write(async tx => {
      const result = await tx.execute(
        `UPDATE assistant_attempts SET status = 'stopping', updated_at = ?
         WHERE id = ? AND status IN ('pending','streaming')`,
        [now, attemptId],
      );
      return result.rowsAffected > 0;
    });
  }

  /**
   * Terminal commit. Exactly one call per attempt can apply (CHAT-003).
   * Selection (CHAT-004): the newest successful/non-empty attempt becomes
   * selected; an empty failure keeps the previous selection.
   */
  finishAttempt(input: FinishInput): Promise<{applied: boolean; selected: boolean}> {
    return this.db.write(tx => finishInTransaction(tx, input));
  }

  /** CHAT-003: on restart every in-flight attempt becomes interrupted; nothing re-executes. */
  recoverInterruptedAttempts(now: number): Promise<number> {
    return this.db.write(async tx => {
      const {rows} = await tx.execute(
        `SELECT id, content FROM assistant_attempts WHERE status IN ${ACTIVE} ORDER BY created_at`,
      );
      for (const row of rows) {
        await finishInTransaction(tx, {
          attemptId: String(row.id),
          status: 'interrupted',
          finishReason: 'interrupted',
          content: String(row.content ?? ''),
          promptTokens: null,
          outputTokens: null,
          errorCode: 'ANSWER_INTERRUPTED',
          now,
        });
      }
      return rows.length;
    });
  }

  /** User picks a prior attempt; allowed only while the turn is the latest (CHAT-005). */
  selectAttempt(turnId: string, attemptId: string): Promise<void> {
    return this.db.write(async tx => {
      const {rows} = await tx.execute(
        `SELECT t.conversation_id, t.ordinal, a.content, a.status,
                (SELECT MAX(ordinal) FROM turns x WHERE x.conversation_id = t.conversation_id) AS latest
         FROM turns t JOIN assistant_attempts a ON a.turn_id = t.id
         WHERE t.id = ? AND a.id = ?`,
        [turnId, attemptId],
      );
      const row = rows[0];
      if (!row) {
        throw new DomainRuleError('attempt-missing');
      }
      if (Number(row.ordinal) !== Number(row.latest)) {
        throw new DomainRuleError('selection-read-only');
      }
      if (['pending', 'streaming', 'stopping'].includes(String(row.status))) {
        throw new DomainRuleError('attempt-active');
      }
      await tx.execute('UPDATE turns SET selected_attempt_id = ? WHERE id = ?', [attemptId, turnId]);
      await indexTurnText(tx, String(row.conversation_id), turnId, 'assistant', String(row.content ?? ''));
    });
  }

  /** DB-004: pages of 30 by ordinal, newest first. */
  async getTurnsBefore(conversationId: string, beforeOrdinal: number | null, limit = TURN_PAGE_SIZE): Promise<Turn[]> {
    const {rows} = await this.db.read(
      `${TURN_SELECT}
       WHERE t.conversation_id = ? AND t.ordinal < ?
       ORDER BY t.ordinal DESC LIMIT ?`,
      [conversationId, beforeOrdinal ?? Number.MAX_SAFE_INTEGER, limit],
    );
    return rows.map(mapTurn);
  }

  /** Newer page, oldest first, used after opening a search hit mid-history. */
  async getTurnsAfter(conversationId: string, afterOrdinal: number, limit = TURN_PAGE_SIZE): Promise<Turn[]> {
    const {rows} = await this.db.read(
      `${TURN_SELECT}
       WHERE t.conversation_id = ? AND t.ordinal > ?
       ORDER BY t.ordinal ASC LIMIT ?`,
      [conversationId, afterOrdinal, limit],
    );
    return rows.map(mapTurn);
  }

  async getTurn(turnId: string): Promise<Turn | null> {
    const {rows} = await this.db.read(`${TURN_SELECT} WHERE t.id = ?`, [turnId]);
    return rows[0] ? mapTurn(rows[0]) : null;
  }

  async getLatestTurn(conversationId: string): Promise<Turn | null> {
    const turns = await this.getTurnsBefore(conversationId, null, 1);
    return turns[0] ?? null;
  }

  /** Prior attempts for the latest turn, newest first (bounded). */
  async getAttempts(turnId: string, limit = 20): Promise<Attempt[]> {
    const {rows} = await this.db.read(
      'SELECT * FROM assistant_attempts WHERE turn_id = ? ORDER BY attempt_number DESC LIMIT ?',
      [turnId, limit],
    );
    return rows.map(row => mapAttempt(row));
  }

  /**
   * CTX-003 source rows: complete user/selected-assistant pairs older than
   * `beforeOrdinal`, newest first. Turns whose selected answer is missing or
   * empty are skipped entirely so no isolated or duplicate role enters the
   * template. Only the selected attempt is ever returned (T18).
   */
  async getContextPairs(
    conversationId: string,
    beforeOrdinal: number,
    limit: number,
    offset: number,
  ): Promise<ContextPair[]> {
    const {rows} = await this.db.read(
      `SELECT t.ordinal, t.user_text, a.content
       FROM turns t JOIN assistant_attempts a ON a.id = t.selected_attempt_id
       WHERE t.conversation_id = ? AND t.ordinal < ? AND a.content <> ''
         AND a.status IN ('complete','stopped','interrupted','failed')
       ORDER BY t.ordinal DESC LIMIT ? OFFSET ?`,
      [conversationId, beforeOrdinal, limit, offset],
    );
    return rows.map(row => ({
      ordinal: Number(row.ordinal),
      userText: String(row.user_text),
      assistantText: String(row.content),
    }));
  }
}

async function assertNoActiveAttempt(tx: SqlExecutor, conversationId: string): Promise<void> {
  const active = await tx.execute(
    `SELECT 1 FROM assistant_attempts a JOIN turns t ON t.id = a.turn_id
     WHERE t.conversation_id = ? AND a.status IN ${ACTIVE} LIMIT 1`,
    [conversationId],
  );
  if (active.rows.length > 0) {
    throw new DomainRuleError('generation-active');
  }
}

async function insertAttempt(tx: SqlExecutor, id: string, turnId: string, n: number, now: number): Promise<void> {
  await tx.execute(
    `INSERT INTO assistant_attempts (id, turn_id, attempt_number, content, status, finish_reason, created_at, updated_at)
     VALUES (?, ?, ?, '', 'pending', NULL, ?, ?)`,
    [id, turnId, n, now, now],
  );
}

async function insertGeneration(
  tx: SqlExecutor,
  id: string,
  attemptId: string,
  g: GenerationRecord,
  now: number,
): Promise<void> {
  await tx.execute(
    `INSERT INTO generations (id, attempt_id, artifact_sha256, runtime_build_id, prompt_version,
                              parameters_json, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, attemptId, g.artifactSha256, g.runtimeBuildId, g.promptVersion, g.parametersJson, now],
  );
}

async function finishInTransaction(
  tx: SqlExecutor,
  input: FinishInput,
): Promise<{applied: boolean; selected: boolean}> {
  const updated = await tx.execute(
    `UPDATE assistant_attempts
     SET status = ?, finish_reason = ?, content = ?, updated_at = ?
     WHERE id = ? AND status IN ${ACTIVE}`,
    [input.status, input.finishReason, input.content, input.now, input.attemptId],
  );
  if (updated.rowsAffected === 0) {
    return {applied: false, selected: false};
  }
  await tx.execute(
    `UPDATE generations
     SET ended_at = ?, output_tokens = ?, error_code = ?,
         prompt_tokens = COALESCE(?, prompt_tokens)
     WHERE attempt_id = ?`,
    [input.now, input.outputTokens, input.errorCode, input.promptTokens, input.attemptId],
  );
  const owner = await tx.execute(
    `SELECT t.id AS turn_id, t.conversation_id FROM assistant_attempts a
     JOIN turns t ON t.id = a.turn_id WHERE a.id = ?`,
    [input.attemptId],
  );
  const turnId = String(owner.rows[0]!.turn_id);
  const conversationId = String(owner.rows[0]!.conversation_id);
  await tx.execute('UPDATE conversations SET updated_at = ? WHERE id = ?', [input.now, conversationId]);

  const selectable = input.status === 'complete' || input.content.length > 0;
  if (!selectable) {
    return {applied: true, selected: false};
  }
  await tx.execute('UPDATE turns SET selected_attempt_id = ? WHERE id = ?', [input.attemptId, turnId]);
  await indexTurnText(tx, conversationId, turnId, 'assistant', input.content);
  return {applied: true, selected: true};
}
