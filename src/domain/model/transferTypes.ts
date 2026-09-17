import {isProductErrorCode, type ProductErrorCode} from '../inference/failures';

/**
 * Typed view of the native transfer snapshot
 * (docs/engineering/native-contract.md §6.5). Transfer state and engine state
 * are deliberately separate types (DL-015).
 */
export type TransferPhase =
  | 'absent'
  | 'waiting'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'staged'
  | 'selfTesting'
  | 'installed'
  | 'failed'
  | 'removing';

const PHASES: readonly TransferPhase[] = [
  'absent', 'waiting', 'downloading', 'paused', 'verifying', 'staged', 'selfTesting', 'installed', 'failed', 'removing',
];

export type InstallState = 'absent' | 'installed' | 'needsRepair';

export interface ArtifactInfo {
  artifactId: string;
  version: string;
  bytes: number;
  sha256: string;
  activatedAt: number;
}

export interface TransferInfo {
  transferId: string;
  isUpdate: boolean;
  artifactVersion: string;
  artifactSha256: string;
  phase: TransferPhase;
  expectedBytes: number;
  committedBytes: number;
  verifiedBytes: number;
  meteredConsent: boolean;
  userPaused: boolean;
  restartedFromZero: boolean;
  retryCount: number;
  nextRetryAt: number | null;
  errorCode: ProductErrorCode | null;
}

export interface TransferSnapshot {
  install: {
    state: InstallState;
    active: ArtifactInfo | null;
    previous: ArtifactInfo | null;
    canRestorePrevious: boolean;
  };
  transfer: TransferInfo | null;
  update: {artifactVersion: string; bytes: number; sequence: number} | null;
  network: {connected: boolean; metered: boolean};
  storage: {freeBytes: number; requiredAdditionalBytes: number};
}

export interface DescriptorSummary {
  valid: boolean;
  artifactVersion: string | null;
  bytes: number | null;
  sha256: string | null;
  errorCode: ProductErrorCode | null;
}

export type UpdateCheckResult = {status: 'none' | 'available' | 'error'; errorCode: ProductErrorCode | null};

export const EMPTY_SNAPSHOT: TransferSnapshot = {
  install: {state: 'absent', active: null, previous: null, canRestorePrevious: false},
  transfer: null,
  update: null,
  network: {connected: false, metered: false},
  storage: {freeBytes: 0, requiredAdditionalBytes: 0},
};

export class SnapshotFormatError extends Error {}

type Json = Record<string, unknown>;

function obj(value: unknown, where: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SnapshotFormatError(where);
  }
  return value as Json;
}
function num(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new SnapshotFormatError(where);
  }
  return value;
}
function str(value: unknown, where: string): string {
  if (typeof value !== 'string') {
    throw new SnapshotFormatError(where);
  }
  return value;
}
function bool(value: unknown): boolean {
  return value === true;
}
function errorCode(value: unknown): ProductErrorCode | null {
  return isProductErrorCode(value) ? value : null;
}

function artifact(value: unknown, where: string): ArtifactInfo | null {
  if (value === null || value === undefined) {
    return null;
  }
  const a = obj(value, where);
  const sha256 = str(a.sha256, `${where}.sha256`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new SnapshotFormatError(`${where}.sha256`);
  }
  return {
    artifactId: str(a.artifactId, `${where}.artifactId`),
    version: str(a.version, `${where}.version`),
    bytes: num(a.bytes, `${where}.bytes`),
    sha256,
    activatedAt: num(a.activatedAt ?? 0, `${where}.activatedAt`),
  };
}

/** Validates native JSON; malformed snapshots are rejected, never guessed at. */
export function parseSnapshot(json: string): TransferSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SnapshotFormatError('json');
  }
  const root = obj(raw, 'root');
  const install = obj(root.install, 'install');
  const state = str(install.state, 'install.state');
  if (state !== 'absent' && state !== 'installed' && state !== 'needsRepair') {
    throw new SnapshotFormatError('install.state');
  }
  let transfer: TransferInfo | null = null;
  if (root.transfer !== null && root.transfer !== undefined) {
    const t = obj(root.transfer, 'transfer');
    const phase = str(t.phase, 'transfer.phase') as TransferPhase;
    if (!PHASES.includes(phase)) {
      throw new SnapshotFormatError('transfer.phase');
    }
    transfer = {
      transferId: str(t.transferId, 'transfer.transferId'),
      isUpdate: bool(t.isUpdate),
      artifactVersion: str(t.artifactVersion, 'transfer.artifactVersion'),
      artifactSha256: str(t.artifactSha256, 'transfer.artifactSha256'),
      phase,
      expectedBytes: num(t.expectedBytes, 'transfer.expectedBytes'),
      committedBytes: num(t.committedBytes, 'transfer.committedBytes'),
      verifiedBytes: num(t.verifiedBytes ?? 0, 'transfer.verifiedBytes'),
      meteredConsent: bool(t.meteredConsent),
      userPaused: bool(t.userPaused),
      restartedFromZero: bool(t.restartedFromZero),
      retryCount: num(t.retryCount ?? 0, 'transfer.retryCount'),
      nextRetryAt: typeof t.nextRetryAt === 'number' ? t.nextRetryAt : null,
      errorCode: errorCode(t.errorCode),
    };
  }
  let update: TransferSnapshot['update'] = null;
  if (root.update !== null && root.update !== undefined) {
    const u = obj(root.update, 'update');
    update = {
      artifactVersion: str(u.artifactVersion, 'update.artifactVersion'),
      bytes: num(u.bytes, 'update.bytes'),
      sequence: num(u.sequence, 'update.sequence'),
    };
  }
  const network = obj(root.network ?? {}, 'network');
  const storage = obj(root.storage ?? {}, 'storage');
  return {
    install: {
      state,
      active: artifact(install.active, 'install.active'),
      previous: artifact(install.previous, 'install.previous'),
      canRestorePrevious: bool(install.canRestorePrevious),
    },
    transfer,
    update,
    network: {connected: bool(network.connected), metered: bool(network.metered)},
    storage: {
      freeBytes: num(storage.freeBytes ?? 0, 'storage.freeBytes'),
      requiredAdditionalBytes: num(storage.requiredAdditionalBytes ?? 0, 'storage.requiredAdditionalBytes'),
    },
  };
}

export function parseDescriptorSummary(json: string): DescriptorSummary {
  try {
    const d = obj(JSON.parse(json), 'summary');
    return {
      valid: bool(d.valid),
      artifactVersion: typeof d.artifactVersion === 'string' ? d.artifactVersion : null,
      bytes: typeof d.bytes === 'number' ? d.bytes : null,
      sha256: typeof d.sha256 === 'string' ? d.sha256 : null,
      errorCode: errorCode(d.errorCode),
    };
  } catch {
    return {valid: false, artifactVersion: null, bytes: null, sha256: null, errorCode: 'SIGNATURE_INVALID'};
  }
}

export function parseUpdateCheck(json: string): UpdateCheckResult {
  try {
    const d = obj(JSON.parse(json), 'update');
    const status = d.status === 'available' || d.status === 'none' ? d.status : 'error';
    return {status, errorCode: errorCode(d.errorCode)};
  } catch {
    return {status: 'error', errorCode: 'TRANSFER_RETRY'};
  }
}
