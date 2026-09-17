import {create} from 'zustand';
import type {ChatSessionState} from '../domain/chat/ChatSessionController';
import {EMPTY_SNAPSHOT, type TransferSnapshot} from '../domain/model/transferTypes';
import type {Preferences} from '../data/repositories/PreferencesRepository';

/**
 * Zustand holds transient UI state only (PRD section 2, ARC-004): mirrors of
 * controller state and preferences. Conversations live in SQLite; the model
 * is only ever "installed" according to the native active pointer (ARC-003).
 */
interface AppState {
  preferences: Preferences | null;
  databaseMode: 'normal' | 'recovery';
  /** Bumped whenever conversation lists must re-query SQLite. */
  conversationsVersion: number;
  setPreferences(preferences: Preferences): void;
  patchPreferences(patch: Partial<Preferences>): void;
  setDatabaseMode(mode: 'normal' | 'recovery'): void;
  touchConversations(): void;
}

export const useAppStore = create<AppState>(set => ({
  preferences: null,
  databaseMode: 'normal',
  conversationsVersion: 0,
  setPreferences: preferences => set({preferences}),
  patchPreferences: patch =>
    set(state => (state.preferences ? {preferences: {...state.preferences, ...patch}} : state)),
  setDatabaseMode: databaseMode => set({databaseMode}),
  touchConversations: () => set(state => ({conversationsVersion: state.conversationsVersion + 1})),
}));

interface TransferState {
  snapshot: TransferSnapshot;
  setSnapshot(snapshot: TransferSnapshot): void;
}

export const useTransferStore = create<TransferState>(set => ({
  snapshot: EMPTY_SNAPSHOT,
  setSnapshot: snapshot => set({snapshot}),
}));

interface ChatSessionMirror {
  session: ChatSessionState;
  setSession(session: ChatSessionState): void;
}

export const useChatSessionStore = create<ChatSessionMirror>(set => ({
  session: {engine: 'unloaded', active: null, blocked: null, lastError: null, unsaved: null},
  setSession: session => set({session}),
}));

/** Which conversation the Chat tab shows (UX-001), and an optional search target. */
interface ChatViewState {
  conversationId: string | null;
  targetOrdinal: number | null;
  /** Incremented to force the Chat screen to reload even for the same ID. */
  nonce: number;
  open(conversationId: string | null, targetOrdinal?: number | null): void;
}

export const useChatViewStore = create<ChatViewState>(set => ({
  conversationId: null,
  targetOrdinal: null,
  nonce: 0,
  open: (conversationId, targetOrdinal = null) =>
    set(state => ({conversationId, targetOrdinal, nonce: state.nonce + 1})),
}));
