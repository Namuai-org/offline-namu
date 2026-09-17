import type {TFunction} from 'i18next';

/**
 * LOC-001: localized byte and date formatting. Sizes use decimal units to
 * match how the package size is published; integrity checks always use exact
 * bytes, never these rounded strings.
 */
function formatNumber(value: number, language: string, fractionDigits: number): string {
  try {
    return new Intl.NumberFormat(language, {
      minimumFractionDigits: 0,
      maximumFractionDigits: fractionDigits,
    }).format(value);
  } catch {
    return value.toFixed(fractionDigits);
  }
}

export function formatBytes(bytes: number, t: TFunction, language: string): string {
  const abs = Math.max(0, bytes);
  if (abs >= 1e9) {
    return t('units.gb', {value: formatNumber(abs / 1e9, language, 2)});
  }
  if (abs >= 1e6) {
    return t('units.mb', {value: formatNumber(abs / 1e6, language, abs >= 1e8 ? 0 : 1)});
  }
  if (abs >= 1e3) {
    return t('units.kb', {value: formatNumber(abs / 1e3, language, 0)});
  }
  return t('units.b', {value: formatNumber(abs, language, 0)});
}

export function formatDateTime(epochMs: number, language: string): string {
  const date = new Date(epochMs);
  const sameDay = new Date().toDateString() === date.toDateString();
  try {
    return new Intl.DateTimeFormat(
      language,
      sameDay ? {hour: '2-digit', minute: '2-digit'} : {year: 'numeric', month: 'short', day: 'numeric'},
    ).format(date);
  } catch {
    return sameDay ? date.toTimeString().slice(0, 5) : date.toISOString().slice(0, 10);
  }
}

export function formatPercent(fraction: number): number {
  return Math.max(0, Math.min(100, Math.floor(fraction * 100)));
}
