#!/usr/bin/env node
/**
 * LOC-001 / T25: en, fr and ha must have identical keys, identical
 * interpolation placeholders per key, complete plural families and no empty
 * strings. Also reports the human-review status required by LOC-002.
 */
const fs = require('fs');
const path = require('path');

const LANGS = ['en', 'fr', 'ha'];
const dir = __dirname;
const files = Object.fromEntries(LANGS.map(l => [l, JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), 'utf8'))]));

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') {
      flatten(v, key, out);
    } else {
      out[key] = v;
    }
  }
  return out;
}
const placeholders = s => [...String(s).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map(m => m[1]).sort().join(',');

const flat = Object.fromEntries(LANGS.map(l => [l, flatten(files[l])]));
const errors = [];
const reference = flat.en;

for (const lang of LANGS) {
  for (const key of Object.keys(reference)) {
    if (!(key in flat[lang])) {
      errors.push(`${lang}: missing key ${key}`);
    }
  }
  for (const key of Object.keys(flat[lang])) {
    if (!(key in reference)) {
      errors.push(`${lang}: extra key ${key}`);
    }
    const value = flat[lang][key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(`${lang}: empty or non-string value at ${key}`);
    } else if (key in reference && placeholders(value) !== placeholders(reference[key])) {
      errors.push(`${lang}: placeholders differ at ${key}: "${placeholders(value)}" vs en "${placeholders(reference[key])}"`);
    }
    if (/<[a-z][^>]*>/i.test(String(value))) {
      errors.push(`${lang}: markup is not allowed in strings (${key})`);
    }
  }
  // Plural families: every *_one needs *_other and must use {{count}}.
  for (const key of Object.keys(flat[lang])) {
    const m = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
    if (m) {
      if (!(`${m[1]}_other` in flat[lang])) {
        errors.push(`${lang}: plural family ${m[1]} has no _other form`);
      }
      if (!/\{\{\s*count\s*\}\}/.test(flat[lang][key])) {
        errors.push(`${lang}: plural form ${key} does not use {{count}}`);
      }
    }
  }
  // LOC-002: Hausa hooked letters must survive as precomposed characters.
  if (lang === 'ha') {
    const text = Object.values(flat.ha).join(' ');
    if (!/[ƙɗɓ]/.test(text)) {
      errors.push('ha: no hooked letters (ƙ, ɗ, ɓ) found — check that the file was not normalized');
    }
  }
}

// The same language names everywhere: each in its own name (S01).
for (const lang of LANGS) {
  for (const code of LANGS) {
    if (flat[lang][`languageNames.${code}`] !== reference[`languageNames.${code}`]) {
      errors.push(`${lang}: languageNames.${code} must be the language's own name`);
    }
  }
}

const review = JSON.parse(fs.readFileSync(path.join(dir, 'review-status.json'), 'utf8'));
console.log(`keys: ${Object.keys(reference).length}`);
for (const lang of LANGS) {
  console.log(`${lang}: review = ${review[lang].status}`);
}
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}
if (process.argv.includes('--release')) {
  const unreviewed = LANGS.filter(l => review[l].status !== 'reviewed');
  if (unreviewed.length > 0) {
    console.error(`Release blocked (LOC-001/LOC-002): human review missing for ${unreviewed.join(', ')}`);
    process.exit(2);
  }
}
console.log('locale files are consistent');
