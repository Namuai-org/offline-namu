import {Database} from '../../src/data/Database';
import {MIGRATIONS} from '../../src/data/migrations';
import {applyMigrations, planMigrations} from '../../src/data/migrations/runner';
import {ChatRepository, type SendIds} from '../../src/data/repositories/ChatRepository';
import {ConversationRepository} from '../../src/data/repositories/ConversationRepository';
import {DraftRepository} from '../../src/data/repositories/DraftRepository';
import {PreferencesRepository} from '../../src/data/repositories/PreferencesRepository';
import {SearchRepository} from '../../src/data/repositories/SearchRepository';
import type {GenerationRecord} from '../../src/data/types';
import {memoryDriver, type NodeSqliteDriver} from './NodeSqliteDriver';

export const GENERATION: GenerationRecord = {
  artifactSha256: 'a'.repeat(64),
  runtimeBuildId: 'llamarn-0.12.9-b10256',
  promptVersion: 'namu-text-1',
  parametersJson: '{}',
};

let counter = 0;
export function nextId(prefix = 'id'): string {
  counter += 1;
  return `${prefix}-${counter.toString().padStart(6, '0')}`;
}

export function sendIds(): SendIds {
  return {
    conversationId: nextId('conv'),
    turnId: nextId('turn'),
    attemptId: nextId('att'),
    generationId: nextId('gen'),
  };
}

export interface TestChatDb {
  driver: NodeSqliteDriver;
  db: Database;
  chat: ChatRepository;
  conversations: ConversationRepository;
  drafts: DraftRepository;
  preferences: PreferencesRepository;
  search: SearchRepository;
}

export async function openTestChatDb(): Promise<TestChatDb> {
  const driver = memoryDriver();
  const plan = await planMigrations(driver, MIGRATIONS);
  await applyMigrations(driver, plan.pending, () => 1);
  const db = await Database.open(driver);
  return {
    driver,
    db,
    chat: new ChatRepository(db),
    conversations: new ConversationRepository(db),
    drafts: new DraftRepository(db),
    preferences: new PreferencesRepository(db),
    search: new SearchRepository(db),
  };
}

/** Sends a user message and completes its first attempt. */
export async function completedTurn(
  t: TestChatDb,
  conversationId: string | null,
  userText: string,
  answer: string,
  now: number,
): Promise<{conversationId: string; turnId: string; attemptId: string}> {
  const sent = await t.chat.send({
    conversationId,
    userText,
    defaultResponseLanguage: 'auto',
    generation: GENERATION,
    ids: sendIds(),
    now,
  });
  await t.chat.markStreaming(sent.attemptId, 10, now);
  await t.chat.finishAttempt({
    attemptId: sent.attemptId,
    status: 'complete',
    finishReason: 'eos',
    content: answer,
    promptTokens: 10,
    outputTokens: 5,
    errorCode: null,
    now: now + 1,
  });
  return {conversationId: sent.conversation.id, turnId: sent.turnId, attemptId: sent.attemptId};
}
