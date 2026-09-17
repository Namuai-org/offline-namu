import type {MemoryLevel, ThermalState} from '../chat/ChatSessionController';
import type {DescriptorSummary, TransferSnapshot, UpdateCheckResult} from './transferTypes';

/** Typed facade over the native transfer service (DL-001). */
export interface TransferService {
  snapshot(): Promise<TransferSnapshot>;
  subscribe(listener: (snapshot: TransferSnapshot) => void): () => void;
  bundledDescriptor(): Promise<DescriptorSummary>;
  start(source: 'bundled' | 'update', allowMetered: boolean): Promise<string>;
  pause(transferId: string): Promise<void>;
  resume(transferId: string, allowMetered: boolean): Promise<void>;
  cancel(transferId: string): Promise<void>;
  checkForUpdate(): Promise<UpdateCheckResult>;
  beginSelfTest(transferId: string): Promise<string>;
  activate(transferId: string, passed: boolean, failureCode: string): Promise<TransferSnapshot>;
  resolveArtifactPath(artifactId: string): Promise<string>;
  setRuntimeReference(artifactId: string | null): void;
  noteSuccessfulForegroundSession(): Promise<void>;
  restorePrevious(markAbandonedBad: boolean): Promise<TransferSnapshot>;
  repair(): Promise<TransferSnapshot>;
  removeModel(): Promise<void>;
  deleteAllTransferData(): Promise<void>;
}

export interface DeviceProfile {
  physicalMemoryBytes: number;
  logicalCpuCount: number;
  freeDiskBytes: number;
  osSupported: boolean;
  abiSupported: boolean;
  metalSupported: boolean;
  thermalApiAvailable: boolean;
}

export interface AppInfo {
  appVersion: string;
  appBuild: number;
  osName: 'android' | 'ios';
  osVersion: string;
  deviceModel: string;
  isSimulator: boolean;
  isInternalBuild: boolean;
}

export interface DeviceService {
  info(): AppInfo;
  profile(): Promise<DeviceProfile>;
  preferredLocales(): string[];
  randomUUID(): string;
  thermalState(): Promise<ThermalState>;
  availableMemoryBytes(): Promise<number>;
  prepareChatDataDirectory(): Promise<string>;
  chatDataSizeBytes(): Promise<number>;
  deleteChatData(): Promise<void>;
  copyToClipboard(text: string): void;
  haptic(kind: 'action' | 'success' | 'error'): void;
  isReduceMotionEnabled(): Promise<boolean>;
  onThermalState(listener: (state: ThermalState) => void): () => void;
  onMemoryPressure(listener: (level: MemoryLevel) => void): () => void;
  /** Hardware Ctrl/Cmd+Enter (A11Y-002). */
  onSendShortcut(listener: () => void): () => void;
}

/** Localized strings handed to the native exporter (SEC-004). */
export interface ExportLabels {
  created: string;
  updated: string;
  responseLanguage: string;
  languageNames: Record<'auto' | 'ha' | 'fr' | 'en', string>;
  you: string;
  namu: string;
  interrupted: string;
  lengthLimited: string;
  untitled: string;
}

export interface ExportService {
  exportConversation(conversationId: string, labels: ExportLabels): Promise<string>;
  exportAll(labels: ExportLabels): Promise<string>;
  share(exportId: string): Promise<boolean>;
  deleteExport(exportId: string): Promise<void>;
  /**
   * SEC-005: delete the temporary file after sharing *when possible*. iOS
   * reports completion, so the file is removed at once. Android only reports
   * that the chooser opened — the receiving app still needs the file, so it is
   * left for the 24-hour sweep. A failed share always deletes.
   */
  cleanupAfterShare(exportId: string, handedOver: boolean): Promise<void>;
  sweep(): Promise<number>;
  deleteAll(): Promise<void>;
}
