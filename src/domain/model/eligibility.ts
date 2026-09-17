import type {DeviceProfile} from './services';

/** DEV-002: conservative eligibility filter, not a performance certification. */
export const MIN_PHYSICAL_MEMORY_BYTES = 5_000_000_000;
/** DL-009 */
export const INSTALL_RESERVE_BYTES = 1024 * 1024 * 1024;
export const RUNNING_RESERVE_BYTES = 256 * 1024 * 1024;

export type IneligibleReason = 'os' | 'abi' | 'memory' | 'metal';

export interface Eligibility {
  eligible: boolean;
  reasons: IneligibleReason[];
}

export function evaluateEligibility(
  profile: DeviceProfile,
  platform: 'android' | 'ios',
  options: {allowSimulatorWithoutMetal?: boolean} = {},
): Eligibility {
  const reasons: IneligibleReason[] = [];
  if (!profile.osSupported) {
    reasons.push('os');
  }
  if (!profile.abiSupported) {
    reasons.push('abi');
  }
  if (profile.physicalMemoryBytes < MIN_PHYSICAL_MEMORY_BYTES) {
    reasons.push('memory');
  }
  if (platform === 'ios' && !profile.metalSupported && !options.allowSimulatorWithoutMetal) {
    reasons.push('metal');
  }
  return {eligible: reasons.length === 0, reasons};
}

/**
 * DL-009: additional free space required = (B − P) + 1 GiB, where P is the
 * durable partial. Installed bytes are already excluded from free space and
 * are never counted twice.
 */
export function requiredAdditionalBytes(expectedBytes: number, durablePartialBytes: number): number {
  return Math.max(0, expectedBytes - durablePartialBytes) + INSTALL_RESERVE_BYTES;
}

export function hasSpaceFor(freeBytes: number, expectedBytes: number, durablePartialBytes: number): boolean {
  return freeBytes >= requiredAdditionalBytes(expectedBytes, durablePartialBytes);
}
