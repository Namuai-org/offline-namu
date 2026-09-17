import {RUNTIME_FIXTURE} from './runtimeFixture';

/**
 * INF-003 guard built from the locked tokenizer's CONTROL tokens (generated
 * runtime fixture). No generic Llama/Qwen marker list is used.
 */
const CONTROL_TOKENS: readonly string[] = RUNTIME_FIXTURE.controlTokens;
const MAX_LENGTH = CONTROL_TOKENS.reduce((max, t) => Math.max(max, t.length), 0);
const ZERO_WIDTH_SPACE = '​';

/** Earliest index of any control token, scanning from just before `from`. */
export function findControlToken(text: string, from: number): number {
  const start = Math.max(0, from - MAX_LENGTH);
  let earliest = -1;
  for (const token of CONTROL_TOKENS) {
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
export function safeEmitLength(raw: string): number {
  const windowStart = Math.max(0, raw.length - (MAX_LENGTH - 1));
  for (let i = windowStart; i < raw.length; i++) {
    const suffix = raw.slice(i);
    if (CONTROL_TOKENS.some(token => token.length > suffix.length && token.startsWith(suffix))) {
      return i;
    }
  }
  return raw.length;
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
