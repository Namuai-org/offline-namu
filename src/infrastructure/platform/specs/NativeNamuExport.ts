import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * Streaming text export and share sheet (SEC-004, SEC-005).
 * Contract: docs/engineering/native-contract.md §7.
 *
 * Native code reads namu.sqlite through its own read-only connection inside a
 * single read transaction (a consistent WAL snapshot) and streams rows to
 * disk; the history is never assembled in JS memory.
 */
export interface Spec extends TurboModule {
  /**
   * labelsJson: localized ExportLabels supplied by JS so native code carries
   * no string tables. Returns an export ID.
   */
  exportConversation(
    dbDirectory: string,
    conversationId: string,
    labelsJson: string,
  ): Promise<string>;
  /** ZIP of per-conversation .txt files plus index.json (schema 1). */
  exportAllConversations(dbDirectory: string, labelsJson: string): Promise<string>;
  /** Presents the OS share/save sheet. Resolves true when the user completed it. */
  share(exportId: string): Promise<boolean>;
  deleteExport(exportId: string): Promise<void>;
  /** Removes leftovers older than 24 hours; returns the number removed. */
  sweepExports(): Promise<number>;
  deleteAllExports(): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NamuExport');
