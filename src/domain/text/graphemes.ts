/**
 * Grapheme-cluster helpers for titles and rename validation (CHAT-007, S05).
 *
 * Uses Intl.Segmenter where the engine provides it. Hermes does not, so the
 * fallback implements the extended-grapheme rules that matter for Namu's
 * content: surrogate pairs, combining marks, variation selectors, ZWJ emoji
 * sequences, emoji modifiers, tag sequences and regional-indicator pairs.
 * Stored text is never normalized or altered (LOC-002); these functions only
 * decide where a string may be cut.
 */
type SegmenterLike = {segment(input: string): Iterable<{segment: string}>};

function nativeSegmenter(): SegmenterLike | null {
  const intl = Intl as unknown as {
    Segmenter?: new (locale?: string, options?: {granularity: 'grapheme'}) => SegmenterLike;
  };
  if (typeof intl.Segmenter === 'function') {
    try {
      return new intl.Segmenter(undefined, {granularity: 'grapheme'});
    } catch {
      return null;
    }
  }
  return null;
}

const COMBINING_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x05bf, 0x05bf],
  [0x05c1, 0x05c2], [0x05c4, 0x05c5], [0x0610, 0x061a], [0x064b, 0x065f],
  [0x0670, 0x0670], [0x06d6, 0x06dc], [0x06df, 0x06e4], [0x06e7, 0x06e8],
  [0x06ea, 0x06ed], [0x0900, 0x0903], [0x093a, 0x094f], [0x0951, 0x0957],
  [0x0962, 0x0963], [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200c, 0x200c], [0x20d0, 0x20ff],
  [0x302a, 0x302f], [0x3099, 0x309a], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
  [0x1f3fb, 0x1f3ff], [0xe0020, 0xe007f], [0xe0100, 0xe01ef],
];

const ZWJ = 0x200d;

function isExtend(cp: number): boolean {
  for (const [lo, hi] of COMBINING_RANGES) {
    if (cp >= lo && cp <= hi) {
      return true;
    }
  }
  return false;
}

function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

function fallbackSegments(input: string): string[] {
  const codePoints = Array.from(input);
  const clusters: string[] = [];
  let i = 0;
  while (i < codePoints.length) {
    let cluster = codePoints[i]!;
    const first = cluster.codePointAt(0)!;
    i++;
    if (cluster === '\r' && codePoints[i] === '\n') {
      cluster += codePoints[i];
      i++;
    } else if (isRegionalIndicator(first) && i < codePoints.length &&
      isRegionalIndicator(codePoints[i]!.codePointAt(0)!)) {
      cluster += codePoints[i];
      i++;
    }
    while (i < codePoints.length) {
      const cp = codePoints[i]!.codePointAt(0)!;
      if (isExtend(cp)) {
        cluster += codePoints[i];
        i++;
      } else if (cp === ZWJ && i + 1 < codePoints.length) {
        cluster += codePoints[i]! + codePoints[i + 1]!;
        i += 2;
      } else {
        break;
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

export function splitGraphemes(input: string, forceFallback = false): string[] {
  const segmenter = forceFallback ? null : nativeSegmenter();
  if (segmenter) {
    return Array.from(segmenter.segment(input), s => s.segment);
  }
  return fallbackSegments(input);
}

export function graphemeLength(input: string): number {
  return splitGraphemes(input).length;
}

export function truncateGraphemes(input: string, max: number): string {
  const clusters = splitGraphemes(input);
  return clusters.length <= max ? input : clusters.slice(0, max).join('');
}

/** Unicode code points, the unit of the 12,000 input limit (CTX-002). */
export function codePointLength(input: string): number {
  let count = 0;
  for (const _ of input) {
    count++;
  }
  return count;
}
