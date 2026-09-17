import type {CodegenTypes, TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * Device, lifecycle and small OS services (DEV-002, INF-007, INF-008, DB-002).
 * Contract: docs/engineering/native-contract.md §2.
 *
 * Structured results cross the bridge as JSON strings and are validated by the
 * typed adapter in src/infrastructure/platform/. Byte counts are doubles.
 */
export type ThermalEvent = {
  /** 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown' */
  state: string;
};

export type MemoryEvent = {
  /** 'warning' | 'critical' */
  level: string;
};

export interface Spec extends TurboModule {
  getConstants(): {
    appVersion: string;
    appBuild: number;
    osName: string;
    osVersion: string;
    /** Coarse hardware identifier, e.g. "SM-A546B" or "iPhone16,1". */
    deviceModel: string;
    isSimulator: boolean;
    /** True for `.internal` builds that may use the development origin. */
    isInternalBuild: boolean;
  };

  /** JSON: DeviceProfile. */
  getDeviceProfile(): Promise<string>;
  /** BCP-47 tags in user preference order. */
  getPreferredLocales(): Array<string>;
  /** Cryptographically generated UUIDv4, lower case. */
  randomUUID(): string;
  getThermalState(): Promise<string>;
  getAvailableMemoryBytes(): Promise<number>;

  /**
   * Creates (if needed) the backup-excluded, file-protected directory that
   * holds namu.sqlite and returns its absolute path.
   */
  prepareChatDataDirectory(): Promise<string>;
  getChatDataSizeBytes(): Promise<number>;
  /** Removes chat DB, diagnostics and preferences files. Engine must be unloaded. */
  deleteChatData(): Promise<void>;

  copyToClipboard(text: string): void;
  /** kind: 'action' | 'success' | 'error' */
  haptic(kind: string): void;
  isReduceMotionEnabled(): Promise<boolean>;

  readonly onThermalStateChanged: CodegenTypes.EventEmitter<ThermalEvent>;
  readonly onMemoryPressure: CodegenTypes.EventEmitter<MemoryEvent>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NamuPlatform');
