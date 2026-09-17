import type {TransferService} from '../../domain/model/services';
import {
  parseDescriptorSummary,
  parseSnapshot,
  parseUpdateCheck,
  type DescriptorSummary,
  type TransferSnapshot,
  type UpdateCheckResult,
} from '../../domain/model/transferTypes';
import NativeNamuTransfer from './specs/NativeNamuTransfer';

/** Typed adapter over the NamuTransfer TurboModule (ARC-003). */
export class NativeTransferService implements TransferService {
  async snapshot(): Promise<TransferSnapshot> {
    return parseSnapshot(await NativeNamuTransfer.snapshot());
  }

  subscribe(listener: (snapshot: TransferSnapshot) => void): () => void {
    const subscription = NativeNamuTransfer.onSnapshot(event => {
      try {
        listener(parseSnapshot(event.json));
      } catch {
        // A malformed snapshot is dropped; the next valid one replaces it.
      }
    });
    return () => subscription.remove();
  }

  async bundledDescriptor(): Promise<DescriptorSummary> {
    return parseDescriptorSummary(await NativeNamuTransfer.getBundledDescriptorSummary());
  }

  start(source: 'bundled' | 'update', allowMetered: boolean): Promise<string> {
    return NativeNamuTransfer.start(source, allowMetered);
  }
  pause(transferId: string): Promise<void> {
    return NativeNamuTransfer.pause(transferId);
  }
  resume(transferId: string, allowMetered: boolean): Promise<void> {
    return NativeNamuTransfer.resume(transferId, allowMetered);
  }
  cancel(transferId: string): Promise<void> {
    return NativeNamuTransfer.cancel(transferId);
  }
  async checkForUpdate(): Promise<UpdateCheckResult> {
    return parseUpdateCheck(await NativeNamuTransfer.checkForUpdate());
  }
  beginSelfTest(transferId: string): Promise<string> {
    return NativeNamuTransfer.beginSelfTest(transferId);
  }
  async activate(transferId: string, passed: boolean, failureCode: string): Promise<TransferSnapshot> {
    return parseSnapshot(await NativeNamuTransfer.activate(transferId, passed, failureCode));
  }
  resolveArtifactPath(artifactId: string): Promise<string> {
    return NativeNamuTransfer.resolveArtifactPath(artifactId);
  }
  setRuntimeReference(artifactId: string | null): void {
    NativeNamuTransfer.setRuntimeReference(artifactId ?? '');
  }
  noteSuccessfulForegroundSession(): Promise<void> {
    return NativeNamuTransfer.noteSuccessfulForegroundSession();
  }
  async restorePrevious(): Promise<TransferSnapshot> {
    return parseSnapshot(await NativeNamuTransfer.restorePrevious());
  }
  async repair(): Promise<TransferSnapshot> {
    return parseSnapshot(await NativeNamuTransfer.repair());
  }
  removeModel(): Promise<void> {
    return NativeNamuTransfer.removeModel();
  }
  deleteAllTransferData(): Promise<void> {
    return NativeNamuTransfer.deleteAllTransferData();
  }
}
