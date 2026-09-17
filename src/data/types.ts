export type ResponseLanguage = 'auto' | 'ha' | 'fr' | 'en';
export const RESPONSE_LANGUAGES: readonly ResponseLanguage[] = ['auto', 'ha', 'fr', 'en'];

export type AttemptStatus =
  | 'pending'
  | 'streaming'
  | 'stopping'
  | 'complete'
  | 'stopped'
  | 'interrupted'
  | 'failed';

export const ACTIVE_ATTEMPT_STATUSES: readonly AttemptStatus[] = ['pending', 'streaming', 'stopping'];
export type TerminalAttemptStatus = 'complete' | 'stopped' | 'interrupted' | 'failed';

export interface Conversation {
  id: string;
  title: string;
  titleIsCustom: boolean;
  responseLanguage: ResponseLanguage;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationListItem extends Conversation {
  /** Short plain-text preview of the latest turn (S05). */
  preview: string;
}

export interface Attempt {
  id: string;
  turnId: string;
  attemptNumber: number;
  content: string;
  status: AttemptStatus;
  finishReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Turn {
  id: string;
  conversationId: string;
  ordinal: number;
  userText: string;
  selectedAttemptId: string | null;
  createdAt: number;
  /** The attempt to display: selected, else the newest one. */
  displayAttempt: Attempt | null;
  attemptCount: number;
}

export interface GenerationRecord {
  artifactSha256: string;
  runtimeBuildId: string;
  promptVersion: string;
  parametersJson: string;
}

export interface ContextPair {
  ordinal: number;
  userText: string;
  assistantText: string;
}

export interface SearchHit {
  conversationId: string;
  conversationTitle: string;
  turnId: string | null;
  ordinal: number | null;
  kind: 'title' | 'user' | 'assistant';
  snippet: string;
  updatedAt: number;
}
