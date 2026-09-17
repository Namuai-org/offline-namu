/** Nearest-rank percentile; no interpolation, no discarded runs (NFR-004: no cherry-picking). */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) {
    return Number.NaN;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1]!;
}

export function median(samples: readonly number[]): number {
  return percentile(samples, 50);
}

export interface GateResult {
  id: string;
  description: string;
  value: number;
  threshold: number;
  comparison: '<=' | '>=';
  samples: number;
  pass: boolean;
}

export function gate(
  id: string,
  description: string,
  value: number,
  comparison: '<=' | '>=',
  threshold: number,
  samples: number,
): GateResult {
  const pass = Number.isFinite(value) && (comparison === '<=' ? value <= threshold : value >= threshold);
  return {id, description, value, threshold, comparison, samples, pass};
}
