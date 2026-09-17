#!/usr/bin/env node
/**
 * DS-004 automated contrast check: text pairs ≥ 4.5:1, control/focus pairs
 * ≥ 3:1, in both themes. Reads the token source directly so it cannot drift.
 */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'tokens.ts'), 'utf8');
function block(name) {
  const m = new RegExp(`export const ${name}: ColorTokens = \\{([^}]*)\\}`).exec(source);
  if (!m) {
    throw new Error(`token block ${name} not found`);
  }
  const out = {};
  for (const [, key, value] of m[1].matchAll(/(\w+):\s*'(#[0-9A-Fa-f]{6})'/g)) {
    out[key] = value;
  }
  return out;
}

function luminance(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;
const CONTROL = 3;
const pairs = [
  ['textPrimary', 'background', TEXT], ['textPrimary', 'surface', TEXT], ['textPrimary', 'surfaceAlt', TEXT],
  ['textSecondary', 'background', TEXT], ['textSecondary', 'surface', TEXT], ['textSecondary', 'surfaceAlt', TEXT],
  ['onAction', 'action', TEXT],
  ['action', 'background', TEXT], ['action', 'surface', TEXT], ['action', 'surfaceAlt', TEXT],
  ['error', 'background', TEXT], ['error', 'surface', TEXT], ['error', 'surfaceAlt', TEXT],
  ['outline', 'background', CONTROL], ['outline', 'surface', CONTROL], ['outline', 'surfaceAlt', CONTROL],
  ['focus', 'background', CONTROL], ['focus', 'surface', CONTROL], ['focus', 'surfaceAlt', CONTROL],
];

let failed = 0;
for (const theme of ['lightColors', 'darkColors']) {
  const colors = block(theme);
  for (const [fg, bg, min] of pairs) {
    const r = ratio(colors[fg], colors[bg]);
    const ok = r >= min;
    if (!ok) {
      failed++;
    }
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${theme.padEnd(11)} ${fg.padEnd(13)} on ${bg.padEnd(10)} ${r.toFixed(2)}:1 (min ${min})`);
  }
}
if (failed > 0) {
  console.error(`\n${failed} contrast pair(s) below the DS-004 minimum.`);
  process.exit(1);
}
console.log('\nAll token pairs meet DS-004.');
