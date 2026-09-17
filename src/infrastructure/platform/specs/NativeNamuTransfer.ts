import type {CodegenTypes, TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * Model delivery service (section 7 and 8 of the PRD).
 * Contract: docs/engineering/native-contract.md §3–§6.
 *
 * The native service owns the transfer journal, staging, verification and the
 * active pointer. JS only observes snapshots and requests transitions
 * (ARC-003). Every call is idempotent by transfer ID (DL-001).
 */
export type SnapshotEvent = {
  /** JSON: TransferSnapshot. Coalesced to at most four events per second. */
  json: string;
};

export interface Spec extends TurboModule {
  /** JSON: TransferSnapshot. */
  snapshot(): Promise<string>;
  /** JSON: DescriptorSummary of the bundled signed descriptor. */
  getBundledDescriptorSummary(): Promise<string>;

  /**
   * source: 'bundled' | 'update'. Returns the transfer ID; returns the existing
   * ID when a transfer for the same artifact already exists.
   */
  start(source: string, allowMetered: boolean): Promise<string>;
  pause(transferId: string): Promise<void>;
  resume(transferId: string, allowMetered: boolean): Promise<void>;
  cancel(transferId: string): Promise<void>;

  /** User initiated only (SIG-005). JSON: UpdateCheckResult. */
  checkForUpdate(): Promise<string>;

  /**
   * Records the pending-activation marker (DL-012) and moves the staged
   * transfer to selfTesting. Returns the candidate artifact ID.
   */
  beginSelfTest(transferId: string): Promise<string>;
  /**
   * Completes DL-010: on pass performs the atomic active-pointer replacement
   * and journal commit; on failure marks the digest locally bad and keeps the
   * old pointer. JSON: TransferSnapshot.
   */
  activate(
    transferId: string,
    selfTestPassed: boolean,
    failureCode: string,
  ): Promise<string>;

  /** Absolute path of a verified release; rejects for unknown artifacts. */
  resolveArtifactPath(artifactId: string): Promise<string>;
  /** Live runtime reference (DL-013); empty string clears it. */
  setRuntimeReference(artifactId: string): void;
  noteSuccessfulForegroundSession(): Promise<void>;

  restorePrevious(): Promise<string>;
  /** Rehashes the active artifact (DL-014). JSON: TransferSnapshot. */
  repair(): Promise<string>;
  removeModel(): Promise<void>;
  /** SEC-006: cancels transfers, removes journal, staging, releases, pointer. */
  deleteAllTransferData(): Promise<void>;

  readonly onSnapshot: CodegenTypes.EventEmitter<SnapshotEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NamuTransfer');
