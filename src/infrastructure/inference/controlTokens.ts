import {RUNTIME_FIXTURE} from './runtimeFixture';

/**
 * INF-003 guard built from the locked tokenizer's CONTROL tokens (generated
 * runtime fixture). No generic Llama/Qwen marker list is used.
 */
const CONTROL_TOKENS: readonly string[] = RUNTIME_FIXTURE.controlTokens;
const MAX_LENGTH = CONTROL_TOKENS.reduce((max, t) => Math.max(max, t.length), 0);
const ZERO_WIDTH_SPACE = '​';

/**
 * Markers that must never be visible: every CONTROL token of the locked
 * vocabulary plus whatever stop strings this request sends to the runtime
 * (the template may add its own).
 */
export function guardMarkers(extraStops: readonly string[] = []): string[] {
  return [...new Set([...CONTROL_TOKENS, ...extraStops.filter(s => s.length > 0)])];
}

/** Earliest index of any marker, scanning from just before `from`. */
export function findControlToken(text: string, from: number, markers: readonly string[] = CONTROL_TOKENS): number {
  const longest = markers.reduce((max, t) => Math.max(max, t.length), MAX_LENGTH);
  const start = Math.max(0, from - longest);
  let earliest = -1;
  for (const token of markers) {
    const at = text.indexOf(token, start);
    if (at !== -1 && (earliest === -1 || at < earliest)) {
      earliest = at;
    }
  }
  return earliest;
}

/**
 * While streaming, hold back a trailing fragment that could still grow into a
 * control token (for example "<|END_RESP"), so partial markers never flash on
 * screen before the stop sequence is recognized.
 */
export function safeEmitLength(
  raw: string,
  markers: readonly string[] = CONTROL_TOKENS,
  minFragment = 1,
): number {
  const longest = markers.reduce((max, t) => Math.max(max, t.length), MAX_LENGTH);
  const windowStart = Math.max(0, raw.length - (longest - 1));
  for (let i = windowStart; i < raw.length; i++) {
    const suffix = raw.slice(i);
    if (suffix.length >= minFragment && markers.some(token => token.length > suffix.length && token.startsWith(suffix))) {
      return i;
    }
  }
  return raw.length;
}

/**
 * Final visible text: cut at the first marker and drop a trailing partial
 * marker of two or more characters (an answer that ended mid-marker because of
 * a stop or the length limit). A lone "<" is ordinary text and is kept.
 */
export function finalVisibleText(text: string, markers: readonly string[] = CONTROL_TOKENS): string {
  const at = findControlToken(text, 0, markers);
  const cut = at === -1 ? text : text.slice(0, at);
  return cut.slice(0, safeEmitLength(cut, markers, 2));
}

/**
 * The runtime tokenizes the formatted prompt with special-token parsing on, so
 * a control marker inside user text would be read as a real role token. The
 * prompt copy (never the stored message) gets a zero-width space inside each
 * marker so it stays ordinary text.
 */
export function neutralizeControlTokens(content: string): string {
  let out = content;
  for (const token of CONTROL_TOKENS) {
    if (out.includes(token)) {
      out = out.split(token).join(token[0] + ZERO_WIDTH_SPACE + token.slice(1));
    }
  }
  return out;
}
