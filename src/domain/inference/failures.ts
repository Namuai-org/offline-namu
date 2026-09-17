/**
 * Product error contract (PRD section 17). Codes are stable, user-facing
 * text is localized under `errors.<CODE>` and error UI never shows stack
 * traces or filesystem paths.
 */
export const PRODUCT_ERROR_CODES = [
  'DEVICE_INELIGIBLE',
  'SPACE_LOW',
  'NETWORK_WAIT',
  'TRANSFER_RETRY',
  'TRANSFER_RESTART',
  'SIGNATURE_INVALID',
  'FILE_DAMAGED',
  'MODEL_INCOMPATIBLE',
  'MODEL_LOAD_FAILED',
  'MEMORY_LOW',
  'DEVICE_HOT',
  'INPUT_TOO_LONG',
  'ANSWER_INTERRUPTED',
  'STORAGE_WRITE_FAILED',
  'DATABASE_RECOVERY',
  'CANCEL_TIMEOUT',
] as const;

export type ProductErrorCode = (typeof PRODUCT_ERROR_CODES)[number];

export function isProductErrorCode(value: unknown): value is ProductErrorCode {
  return typeof value === 'string' && (PRODUCT_ERROR_CODES as readonly string[]).includes(value);
}

/** Typed inference failure raised by engine adapters. */
export class InferenceFailure extends Error {
  constructor(
    readonly code: Extract<
      ProductErrorCode,
      'MODEL_LOAD_FAILED' | 'MEMORY_LOW' | 'CANCEL_TIMEOUT' | 'ANSWER_INTERRUPTED' | 'MODEL_INCOMPATIBLE'
    >,
    /** Sanitized detail for local diagnostics only; never shown to users. */
    readonly detail: string = '',
  ) {
    super(code);
  }
}

/** DEV-004: Metal did not initialize on iOS. Chats are preserved; no CPU fallback. */
export class UnsupportedRuntimeFailure extends InferenceFailure {
  constructor(detail: string) {
    super('MODEL_LOAD_FAILED', `unsupported-runtime:${detail}`);
  }
}
