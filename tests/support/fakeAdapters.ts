import type {MemoryLevel, ThermalState} from '../../src/domain/chat/ChatSessionController';
import type {
  AppInfo,
  DeviceProfile,
  DeviceService,
  ExportLabels,
  ExportService,
  TransferService,
} from '../../src/domain/model/services';
import type {
  DescriptorSummary,
  TransferInfo,
  TransferSnapshot,
  UpdateCheckResult,
} from '../../src/domain/model/transferTypes';
import type {PlatformAdapters} from '../../src/app/services';
import {FakeInferenceEngine} from '../../src/infrastructure/inference/fake/FakeInferenceEngine';
import {NodeSqliteFactory, makeTempDir} from './NodeSqliteDriver';

const SHA = 'c'.repeat(64);
export const FAKE_BYTES = 2_143_977_056;

/** In-memory stand-in for the native transfer service (QA-004). */
export class FakeTransferService implements TransferService {
  snapshotValue: TransferSnapshot = {
    install: {state: 'absent', active: null, previous: null, canRestorePrevious: false},
    transfer: null,
    update: null,
    network: {connected: true, metered: false},
    storage: {freeBytes: 30e9, requiredAdditionalBytes: 0},
  };
  descriptor: DescriptorSummary = {valid: true, artifactVersion: 'aya-global-q4km-1', bytes: FAKE_BYTES, sha256: SHA, errorCode: null};
  readonly calls: string[] = [];
  private listeners = new Set<(s: TransferSnapshot) => void>();

  emit(patch: Partial<TransferSnapshot>): void {
    this.snapshotValue = {...this.snapshotValue, ...patch};
    this.listeners.forEach(l => l(this.snapshotValue));
  }
  setTransfer(patch: Partial<TransferInfo> | null): void {
    const current = this.snapshotValue.transfer;
    this.emit({transfer: patch === null ? null : ({...(current as TransferInfo), ...patch} as TransferInfo)});
  }
  installNow(): void {
    this.emit({
      transfer: null,
      install: {
        state: 'installed',
        active: {artifactId: SHA, version: 'aya-global-q4km-1', bytes: FAKE_BYTES, sha256: SHA, activatedAt: 1},
        previous: null,
        canRestorePrevious: false,
      },
    });
  }

  async snapshot() {
    return this.snapshotValue;
  }
  subscribe(listener: (s: TransferSnapshot) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async bundledDescriptor() {
    return this.descriptor;
  }
  async start(source: 'bundled' | 'update', allowMetered: boolean) {
    this.calls.push(`start:${source}:${allowMetered}`);
    this.emit({
      transfer: {
        transferId: 't1', isUpdate: source === 'update', artifactVersion: 'aya-global-q4km-1', artifactSha256: SHA,
        phase: 'downloading', expectedBytes: FAKE_BYTES, committedBytes: 0, verifiedBytes: 0, meteredConsent: allowMetered,
        userPaused: false, restartedFromZero: false, retryCount: 0, nextRetryAt: null, errorCode: null,
      },
    });
    return 't1';
  }
  async pause(id: string) {
    this.calls.push(`pause:${id}`);
    this.setTransfer({phase: 'paused', userPaused: true});
  }
  async resume(id: string, allowMetered: boolean) {
    this.calls.push(`resume:${id}:${allowMetered}`);
    this.setTransfer({phase: 'downloading', userPaused: false, meteredConsent: allowMetered});
  }
  async cancel(id: string) {
    this.calls.push(`cancel:${id}`);
    this.emit({transfer: null});
  }
  async checkForUpdate(): Promise<UpdateCheckResult> {
    this.calls.push('checkForUpdate');
    return {status: 'none', errorCode: null};
  }
  async beginSelfTest(id: string) {
    this.calls.push(`beginSelfTest:${id}`);
    this.setTransfer({phase: 'selfTesting'});
    return SHA;
  }
  async activate(id: string, passed: boolean, failureCode: string) {
    this.calls.push(`activate:${id}:${passed}:${failureCode}`);
    if (passed) {
      this.installNow();
    } else {
      this.setTransfer({phase: 'failed', errorCode: 'MODEL_LOAD_FAILED'});
    }
    return this.snapshotValue;
  }
  async resolveArtifactPath() {
    return '/fake/model.gguf';
  }
  setRuntimeReference(id: string | null) {
    this.calls.push(`runtimeRef:${id ?? 'none'}`);
  }
  async noteSuccessfulForegroundSession() {
    this.calls.push('sessionSuccess');
  }
  async restorePrevious() {
    this.calls.push('restorePrevious');
    return this.snapshotValue;
  }
  async repair() {
    this.calls.push('repair');
    return this.snapshotValue;
  }
  async removeModel() {
    this.calls.push('removeModel');
    this.emit({install: {state: 'absent', active: null, previous: null, canRestorePrevious: false}, transfer: null});
  }
  async deleteAllTransferData() {
    this.calls.push('deleteAllTransferData');
    await this.removeModel();
  }
}

export class FakeDeviceService implements DeviceService {
  profileValue: DeviceProfile = {
    physicalMemoryBytes: 8e9, logicalCpuCount: 8, freeDiskBytes: 30e9,
    osSupported: true, abiSupported: true, metalSupported: true, thermalApiAvailable: true,
  };
  locales = ['en-US'];
  clipboard: string[] = [];
  haptics: string[] = [];
  deleted = false;
  readonly directory = makeTempDir();
  private thermal = new Set<(s: ThermalState) => void>();
  private memory = new Set<(l: MemoryLevel) => void>();
  private shortcut = new Set<() => void>();
  private uuid = 0;

  info(): AppInfo {
    return {appVersion: '1.0.0', appBuild: 1, osName: 'android', osVersion: '14', deviceModel: 'TEST', isSimulator: false, isInternalBuild: true};
  }
  async profile() {
    return this.profileValue;
  }
  preferredLocales() {
    return this.locales;
  }
  randomUUID() {
    this.uuid += 1;
    return `00000000-0000-4000-8000-${this.uuid.toString().padStart(12, '0')}`;
  }
  async thermalState(): Promise<ThermalState> {
    return 'nominal';
  }
  async availableMemoryBytes() {
    return 4e9;
  }
  async prepareChatDataDirectory() {
    return this.directory;
  }
  async chatDataSizeBytes() {
    return 123_456;
  }
  async deleteChatData() {
    this.deleted = true;
  }
  copyToClipboard(text: string) {
    this.clipboard.push(text);
  }
  haptic(kind: 'action' | 'success' | 'error') {
    this.haptics.push(kind);
  }
  async isReduceMotionEnabled() {
    return true;
  }
  onThermalState(listener: (s: ThermalState) => void) {
    this.thermal.add(listener);
    return () => this.thermal.delete(listener);
  }
  onMemoryPressure(listener: (l: MemoryLevel) => void) {
    this.memory.add(listener);
    return () => this.memory.delete(listener);
  }
  onSendShortcut(listener: () => void) {
    this.shortcut.add(listener);
    return () => this.shortcut.delete(listener);
  }
  emitThermal(state: ThermalState) {
    this.thermal.forEach(l => l(state));
  }
  emitMemory(level: MemoryLevel) {
    this.memory.forEach(l => l(level));
  }
  pressSendShortcut() {
    this.shortcut.forEach(l => l());
  }
}

export class FakeExportService implements ExportService {
  readonly calls: string[] = [];
  failNext = false;
  async exportConversation(id: string, labels: ExportLabels) {
    this.calls.push(`conversation:${id}:${labels.you}`);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('low space');
    }
    return 'export-1';
  }
  async exportAll() {
    this.calls.push('all');
    return 'export-all';
  }
  async share(id: string) {
    this.calls.push(`share:${id}`);
    return true;
  }
  async deleteExport(id: string) {
    this.calls.push(`delete:${id}`);
  }
  async sweep() {
    this.calls.push('sweep');
    return 0;
  }
  async deleteAll() {
    this.calls.push('deleteAll');
  }
}

export interface FakeWorld {
  adapters: PlatformAdapters;
  transfer: FakeTransferService;
  device: FakeDeviceService;
  exporter: FakeExportService;
  engine: FakeInferenceEngine;
  announcements: string[];
}

export function makeFakeWorld(): FakeWorld {
  const transfer = new FakeTransferService();
  const device = new FakeDeviceService();
  const exporter = new FakeExportService();
  const engine = new FakeInferenceEngine();
  const announcements: string[] = [];
  return {
    transfer, device, exporter, engine, announcements,
    adapters: {
      device,
      transfer,
      createExporter: () => exporter,
      sqlite: new NodeSqliteFactory(),
      createEngine: () => engine,
      announce: message => void announcements.push(message),
    },
  };
}
