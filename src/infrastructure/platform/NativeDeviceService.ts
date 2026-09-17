import type {MemoryLevel, ThermalState} from '../../domain/chat/ChatSessionController';
import type {AppInfo, DeviceProfile, DeviceService} from '../../domain/model/services';
import NativeNamuPlatform from './specs/NativeNamuPlatform';

const THERMAL: readonly ThermalState[] = ['nominal', 'fair', 'serious', 'critical', 'unknown'];

function toThermal(value: string): ThermalState {
  return (THERMAL as readonly string[]).includes(value) ? (value as ThermalState) : 'unknown';
}

/** Typed adapter over the NamuPlatform TurboModule. */
export class NativeDeviceService implements DeviceService {
  info(): AppInfo {
    const c = NativeNamuPlatform.getConstants();
    return {
      appVersion: c.appVersion,
      appBuild: c.appBuild,
      // Native reports a display name ("iOS"); the domain uses lower-case identifiers.
      osName: c.osName.toLowerCase() === 'ios' ? 'ios' : 'android',
      osVersion: c.osVersion,
      deviceModel: c.deviceModel,
      isSimulator: c.isSimulator,
      isInternalBuild: c.isInternalBuild,
    };
  }

  async profile(): Promise<DeviceProfile> {
    const raw = JSON.parse(await NativeNamuPlatform.getDeviceProfile()) as Partial<DeviceProfile>;
    // Missing or malformed fields fail closed: the device is treated as ineligible.
    return {
      physicalMemoryBytes: typeof raw.physicalMemoryBytes === 'number' ? raw.physicalMemoryBytes : 0,
      logicalCpuCount: typeof raw.logicalCpuCount === 'number' ? raw.logicalCpuCount : 1,
      freeDiskBytes: typeof raw.freeDiskBytes === 'number' ? raw.freeDiskBytes : 0,
      osSupported: raw.osSupported === true,
      abiSupported: raw.abiSupported === true,
      metalSupported: raw.metalSupported === true,
      thermalApiAvailable: raw.thermalApiAvailable === true,
    };
  }

  preferredLocales(): string[] {
    return NativeNamuPlatform.getPreferredLocales();
  }
  randomUUID(): string {
    return NativeNamuPlatform.randomUUID();
  }
  async thermalState(): Promise<ThermalState> {
    return toThermal(await NativeNamuPlatform.getThermalState());
  }
  availableMemoryBytes(): Promise<number> {
    return NativeNamuPlatform.getAvailableMemoryBytes();
  }
  prepareChatDataDirectory(): Promise<string> {
    return NativeNamuPlatform.prepareChatDataDirectory();
  }
  chatDataSizeBytes(): Promise<number> {
    return NativeNamuPlatform.getChatDataSizeBytes();
  }
  deleteChatData(): Promise<void> {
    return NativeNamuPlatform.deleteChatData();
  }
  copyToClipboard(text: string): void {
    NativeNamuPlatform.copyToClipboard(text);
  }
  haptic(kind: 'action' | 'success' | 'error'): void {
    NativeNamuPlatform.haptic(kind);
  }
  isReduceMotionEnabled(): Promise<boolean> {
    return NativeNamuPlatform.isReduceMotionEnabled();
  }
  onThermalState(listener: (state: ThermalState) => void): () => void {
    const subscription = NativeNamuPlatform.onThermalStateChanged(event => listener(toThermal(event.state)));
    return () => subscription.remove();
  }
  onSendShortcut(listener: () => void): () => void {
    const subscription = NativeNamuPlatform.onSendShortcut(() => listener());
    return () => subscription.remove();
  }
  onMemoryPressure(listener: (level: MemoryLevel) => void): () => void {
    const subscription = NativeNamuPlatform.onMemoryPressure(event =>
      listener(event.level === 'critical' ? 'critical' : 'warning'),
    );
    return () => subscription.remove();
  }
}
