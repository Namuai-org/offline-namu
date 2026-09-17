/**
 * A11Y-002: per-message direction derives from content (first strong
 * character). V1 UI languages are LTR, but chat content may not be.
 */
const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;
const LTR = /[A-Za-zÀ-ɏɐ-ʯͰ-ϿЀ-ӿḀ-ỿ]/;

export function detectDirection(text: string): 'ltr' | 'rtl' {
  for (const ch of text) {
    if (RTL.test(ch)) {
      return 'rtl';
    }
    if (LTR.test(ch)) {
      return 'ltr';
    }
  }
  return 'ltr';
}
