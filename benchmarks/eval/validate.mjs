#!/usr/bin/env node
// Namu language-quality evaluation set validator (EVAL-001). Dependency-free; Node >= 18.
// Usage: node benchmarks/eval/validate.mjs [path/to/namu-eval-v1.jsonl]
// Exits non-zero on any structural violation. Prints the fixture hash (OBS-003) and a count table.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(process.argv[2] ?? join(HERE, 'namu-eval-v1.jsonl'));

const LANGS = ['ha', 'fr', 'en'];
const CATEGORY_COUNTS = {
  explain: 25,
  translate: 20,
  summarize: 15,
  multiturn: 15,
  uncertainty: 15,
  safety: 10,
};
const CATS = Object.keys(CATEGORY_COUNTS);
const MIXED_COUNT = 30;
const TOTAL = LANGS.length * 100 + MIXED_COUNT; // 330
const MIX_PAIRS = ['ha-fr', 'ha-en', 'fr-en'];
const SETTINGS = ['auto', 'ha', 'fr', 'en'];
const CHECK_KEYS = [
  'must_not_claim_browsing',
  'must_express_uncertainty',
  'must_recommend_qualified_help',
  'must_refuse_or_redirect',
  'critical_safety',
];
const REQUIRED_KEYS = [
  'id',
  'language',
  'category',
  'response_language_setting',
  'expected_response_language',
  'turns',
  'checks',
  'reviewer_notes',
];
const OPTIONAL_KEYS = {
  translate: ['source_language', 'target_language'],
  mixed: ['mix_pair', 'acceptable_response_languages'],
};
const HAUSA_HOOKED = /[ƙɗɓƴƘƊƁƳ]/u;
const FRENCH_ACCENT = /[àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ]/u;
const EMOJI = /\p{Extended_Pictographic}/u;
// Names by which a prompt may refer to each target language (in Hausa, French or English).
const LANGUAGE_NAMES = {
  ha: /\b(hausa|haoussa)\b/iu,
  fr: /\b(faransanci|fran[cç]ais|french)\b/iu,
  en: /\b(turanci|anglais|anglaise|english)\b/iu,
};
const VS16 = String.fromCodePoint(0xfe0f); // emoji variation selector: the only combining mark allowed
const HA_MIN_HOOKED_ITEMS = 60;
const SUMMARY_MIN_WORDS = 80;
const SUMMARY_MAX_WORDS = 200;

const errors = [];
const err = (id, msg) => errors.push(`${id ?? '(file)'}: ${msg}`);

const words = (s) => s.split(/\s+/u).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const normalizePrompt = (s) =>
  s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function walkStrings(value, path, visit) {
  if (typeof value === 'string') visit(value, path);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, `${path}[${i}]`, visit));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) walkStrings(v, `${path}.${k}`, visit);
}

// ---------- read ----------
let raw;
try {
  raw = readFileSync(FILE);
} catch (e) {
  console.error(`FAIL: cannot read ${FILE}: ${e.message}`);
  process.exit(2);
}
const fixtureHash = createHash('sha256').update(raw).digest('hex');
const text = raw.toString('utf8');
if (text.includes('\r')) err(null, 'file contains CR characters; use LF line endings so the fixture hash is stable');
if (text.charCodeAt(0) === 0xfeff) err(null, 'file starts with a BOM');
if (!text.endsWith('\n')) err(null, 'file must end with a single trailing newline');

const rawLines = text.split('\n');
if (rawLines[rawLines.length - 1] === '') rawLines.pop();
if (rawLines.length !== TOTAL) err(null, `expected exactly ${TOTAL} lines, found ${rawLines.length}`);

const items = [];
rawLines.forEach((line, i) => {
  if (line.trim() === '') return err(null, `line ${i + 1} is blank`);
  try {
    const obj = JSON.parse(line);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return err(null, `line ${i + 1} is not a JSON object`);
    items.push({ obj, line: i + 1 });
  } catch (e) {
    err(null, `line ${i + 1} does not parse: ${e.message}`);
  }
});

// ---------- per-item checks ----------
const seenIds = new Set();
const seenFinalPrompts = new Map();
const seenConversations = new Map();
const counts = {}; // language -> category -> n
const seqs = {}; // "lang-cat" -> [numbers]
const stats = {
  haHooked: 0,
  mixedPairs: {},
  mixedEmoji: 0,
  mixedHookedPlusAccent: 0,
  translateDirections: {},
  critical: {},
  fixedSetting: 0,
  overrideCrossLanguage: 0,
};

for (const { obj: it, line } of items) {
  const id = typeof it.id === 'string' ? it.id : `line ${line}`;

  // keys
  for (const k of REQUIRED_KEYS) if (!(k in it)) err(id, `missing required field "${k}"`);
  const allowed = new Set([...REQUIRED_KEYS, ...(OPTIONAL_KEYS[it.category] ?? [])]);
  for (const k of Object.keys(it)) if (!allowed.has(k)) err(id, `unexpected field "${k}"`);

  // strings: non-empty, trimmed, NFC, precomposed, no personal-data patterns
  walkStrings(it, '', (s, path) => {
    if (s.trim() === '') err(id, `empty string at ${path}`);
    if (s !== s.trim()) err(id, `leading/trailing whitespace at ${path}`);
    if (s !== s.normalize('NFC')) err(id, `string at ${path} is not NFC-normalised`);
    if (/\p{M}/u.test(s.replaceAll(VS16, ''))) err(id, `combining diacritic at ${path}; use precomposed characters`);
    if (/\d{7,}/u.test(s)) err(id, `long digit run at ${path} (possible phone/ID number; set must contain no personal data)`);
    if (/[\w.+-]+@[\w-]+\.[\w.]+/u.test(s)) err(id, `e-mail-like string at ${path}`);
    if (/https?:\/\/|www\./iu.test(s)) err(id, `URL at ${path}`);
  });

  // language / category / id
  const isMixed = it.language === 'mixed';
  if (!isMixed && !LANGS.includes(it.language)) err(id, `invalid language "${it.language}"`);
  if (isMixed ? it.category !== 'mixed' : !CATS.includes(it.category))
    err(id, `invalid category "${it.category}" for language "${it.language}"`);
  const idMatch = /^(ha|fr|en|mixed)-([a-z]+)-(\d{3})$/u.exec(String(it.id));
  if (!idMatch) err(id, 'id is not of the form <language>-<category>-NNN');
  else {
    if (idMatch[1] !== it.language || idMatch[2] !== it.category)
      err(id, 'id prefix does not match language/category fields');
    (seqs[`${idMatch[1]}-${idMatch[2]}`] ??= []).push(Number(idMatch[3]));
  }
  if (seenIds.has(it.id)) err(id, 'duplicate id');
  seenIds.add(it.id);
  ((counts[it.language] ??= {})[it.category] ??= 0);
  counts[it.language][it.category] += 1;

  // response language fields
  const setting = it.response_language_setting;
  const expected = it.expected_response_language;
  if (!SETTINGS.includes(setting)) err(id, `invalid response_language_setting "${setting}"`);
  if (!LANGS.includes(expected)) err(id, `invalid expected_response_language "${expected}"`);
  if (setting !== 'auto') {
    stats.fixedSetting += 1;
    if (expected !== setting) err(id, 'expected_response_language must equal a fixed response_language_setting');
    if (!isMixed && setting !== it.language) stats.overrideCrossLanguage += 1;
  } else if (!isMixed && !['translate', 'multiturn'].includes(it.category) && expected !== it.language) {
    err(id, 'with setting "auto", expected_response_language must equal the prompt language for this category');
  }

  // turns
  const turns = it.turns;
  if (!Array.isArray(turns) || turns.length === 0) {
    err(id, 'turns must be a non-empty array');
    continue;
  }
  turns.forEach((t, i) => {
    const keys = t && typeof t === 'object' ? Object.keys(t).sort().join(',') : '';
    if (keys !== 'content,role') return err(id, `turn ${i} must have exactly {role, content}`);
    const want = i % 2 === 0 ? 'user' : 'assistant';
    if (t.role !== want) err(id, `turn ${i} has role "${t.role}", expected "${want}" (turns must alternate, starting with user)`);
    if (typeof t.content !== 'string') err(id, `turn ${i} content must be a string`);
  });
  if (turns[turns.length - 1]?.role !== 'user') err(id, 'last turn must have role "user"');
  if (it.category === 'multiturn') {
    if (turns.length < 3) err(id, 'multiturn items need at least 3 turns');
  } else if (turns.length !== 1) err(id, `${it.category} items must have exactly 1 turn`);

  const userTurns = turns.filter((t) => t.role === 'user' && typeof t.content === 'string').map((t) => t.content);
  const userText = userTurns.join('\n');
  const finalPrompt = String(turns[turns.length - 1]?.content ?? '');

  // duplicates (normalised)
  const nFinal = normalizePrompt(finalPrompt);
  const nConv = normalizePrompt(userText);
  if (it.category !== 'multiturn') {
    if (seenFinalPrompts.has(nFinal)) err(id, `duplicate user prompt (same as ${seenFinalPrompts.get(nFinal)})`);
    seenFinalPrompts.set(nFinal, it.id);
  }
  if (seenConversations.has(nConv)) err(id, `duplicate user conversation (same as ${seenConversations.get(nConv)})`);
  seenConversations.set(nConv, it.id);
  if (words(finalPrompt) < 3) err(id, 'final user prompt is too short to be meaningful');

  // checks block
  const ck = it.checks;
  if (!ck || typeof ck !== 'object' || Object.keys(ck).sort().join() !== [...CHECK_KEYS].sort().join())
    err(id, `checks must contain exactly: ${CHECK_KEYS.join(', ')}`);
  else {
    for (const k of CHECK_KEYS) if (typeof ck[k] !== 'boolean') err(id, `checks.${k} must be boolean`);
    if (ck.must_not_claim_browsing !== true) err(id, 'checks.must_not_claim_browsing must be true (CTX-001)');
    if (it.category === 'uncertainty' && ck.must_express_uncertainty !== true)
      err(id, 'uncertainty items must set must_express_uncertainty');
    if (it.category === 'safety' && !ck.must_recommend_qualified_help && !ck.must_refuse_or_redirect)
      err(id, 'safety items must set must_recommend_qualified_help and/or must_refuse_or_redirect');
    if (ck.critical_safety) {
      if (it.category !== 'safety') err(id, 'critical_safety may only be set on safety items');
      stats.critical[it.language] = (stats.critical[it.language] ?? 0) + 1;
    }
  }

  // reviewer notes
  if (typeof it.reviewer_notes !== 'string' || words(it.reviewer_notes) < 5)
    err(id, 'reviewer_notes must be a meaningful English sentence');

  // Hausa orthography
  if (it.language === 'ha') {
    if (HAUSA_HOOKED.test(userText)) stats.haHooked += 1;
    if (/(^|[\s«"(])['’ʼ]y/iu.test(userText)) err(id, `apostrophe digraph 'y found; write ƴ (U+01B4) instead`);
  }

  // translate
  if (it.category === 'translate') {
    const { source_language: src, target_language: tgt } = it;
    if (!LANGS.includes(src) || !LANGS.includes(tgt)) err(id, 'translate items need valid source_language and target_language');
    else {
      if (src === tgt) err(id, 'source_language and target_language must differ');
      if (tgt !== expected) err(id, 'target_language must equal expected_response_language');
      if (src !== it.language && tgt !== it.language)
        err(id, 'translate item must translate from or into the item language');
      if (!LANGUAGE_NAMES[tgt].test(finalPrompt))
        err(id, `prompt does not name the target language (${tgt}) consistently with expected_response_language`);
      stats.translateDirections[`${src}->${tgt}`] = (stats.translateDirections[`${src}->${tgt}`] ?? 0) + 1;
    }
  }

  // summarize: embedded source passage of 80–200 words
  if (it.category === 'summarize') {
    const paragraphs = finalPrompt.split(/\n\s*\n/u);
    if (paragraphs.length < 2) err(id, 'summarize prompt must contain an instruction and a source passage separated by a blank line');
    const passageWords = Math.max(...paragraphs.map(words));
    if (passageWords < SUMMARY_MIN_WORDS || passageWords > SUMMARY_MAX_WORDS)
      err(id, `source passage has ${passageWords} words; expected ${SUMMARY_MIN_WORDS}–${SUMMARY_MAX_WORDS}`);
  }

  // mixed
  if (isMixed) {
    const pair = it.mix_pair;
    const acc = it.acceptable_response_languages;
    if (!MIX_PAIRS.includes(pair)) err(id, `mix_pair must be one of ${MIX_PAIRS.join(', ')}`);
    else {
      stats.mixedPairs[pair] = (stats.mixedPairs[pair] ?? 0) + 1;
      const pairLangs = pair.split('-');
      if (!Array.isArray(acc) || acc.length === 0 || acc.some((l) => !pairLangs.includes(l)) || new Set(acc).size !== acc.length)
        err(id, 'acceptable_response_languages must be a non-empty subset of the mix_pair languages');
      else {
        if (acc[0] !== expected) err(id, 'acceptable_response_languages[0] must equal expected_response_language');
        if (setting !== 'auto' && (acc.length !== 1 || acc[0] !== setting))
          err(id, 'with a fixed setting, acceptable_response_languages must be exactly [setting]');
      }
    }
    if (EMOJI.test(userText)) stats.mixedEmoji += 1;
    if (HAUSA_HOOKED.test(userText) && FRENCH_ACCENT.test(userText)) stats.mixedHookedPlusAccent += 1;
  }
}

// ---------- set-level checks ----------
for (const lang of LANGS) {
  let total = 0;
  for (const cat of CATS) {
    const n = counts[lang]?.[cat] ?? 0;
    total += n;
    if (n !== CATEGORY_COUNTS[cat]) err(null, `${lang}/${cat}: expected ${CATEGORY_COUNTS[cat]} items, found ${n}`);
  }
  if (total !== 100) err(null, `${lang}: expected 100 items, found ${total}`);
  const crit = stats.critical[lang] ?? 0;
  if (crit < 3 || crit > 4) err(null, `${lang}: expected 3–4 critical_safety items, found ${crit}`);
}
const mixedN = counts.mixed?.mixed ?? 0;
if (mixedN !== MIXED_COUNT) err(null, `mixed: expected ${MIXED_COUNT} items, found ${mixedN}`);
for (const pair of MIX_PAIRS) if (!stats.mixedPairs[pair]) err(null, `mixed: no items for pair ${pair}`);
if (stats.mixedEmoji < 5) err(null, `mixed: expected at least 5 items containing emoji, found ${stats.mixedEmoji}`);
if (stats.mixedHookedPlusAccent < 3)
  err(null, `mixed: expected at least 3 items combining Hausa hooked letters with French accents, found ${stats.mixedHookedPlusAccent}`);
if (stats.haHooked < HA_MIN_HOOKED_ITEMS)
  err(null, `ha: only ${stats.haHooked} of 100 items contain ƙ/ɗ/ɓ/ƴ; need at least ${HA_MIN_HOOKED_ITEMS}`);
for (const dir of ['ha->fr', 'fr->ha', 'ha->en', 'en->ha', 'fr->en', 'en->fr'])
  if (!stats.translateDirections[dir]) err(null, `translate: direction ${dir} is not covered`);
for (const [key, nums] of Object.entries(seqs)) {
  const sorted = [...nums].sort((a, b) => a - b);
  if (sorted.some((n, i) => n !== i + 1)) err(null, `${key}: id sequence numbers must run 001..${String(nums.length).padStart(3, '0')} without gaps`);
}

// ---------- report ----------
const col = (s, w) => String(s).padEnd(w);
const num = (s, w) => String(s).padStart(w);
console.log(`Namu evaluation set: ${FILE}`);
console.log(`Items parsed: ${items.length}`);
console.log('');
console.log(col('language', 10) + CATS.map((c) => num(c, 12)).join('') + num('mixed', 8) + num('total', 8));
for (const lang of [...LANGS, 'mixed']) {
  const row = CATS.map((c) => counts[lang]?.[c] ?? 0);
  const mixedCell = counts[lang]?.mixed ?? 0;
  const total = row.reduce((a, b) => a + b, 0) + mixedCell;
  console.log(col(lang, 10) + row.map((n) => num(n, 12)).join('') + num(mixedCell, 8) + num(total, 8));
}
console.log('');
console.log(`Hausa items containing ƙ/ɗ/ɓ/ƴ: ${stats.haHooked}/100 (minimum ${HA_MIN_HOOKED_ITEMS})`);
console.log(`Critical safety items: ${LANGS.map((l) => `${l}=${stats.critical[l] ?? 0}`).join(' ')}`);
console.log(`Translation directions: ${Object.entries(stats.translateDirections).map(([k, v]) => `${k}:${v}`).join(' ')}`);
console.log(`Mixed pairs: ${Object.entries(stats.mixedPairs).map(([k, v]) => `${k}:${v}`).join(' ')}; with emoji: ${stats.mixedEmoji}; hooked letters + French accents: ${stats.mixedHookedPlusAccent}`);
console.log(`Items with a fixed response-language setting: ${stats.fixedSetting} (of which cross-language overrides outside "mixed": ${stats.overrideCrossLanguage})`);
console.log('');
console.log(`Fixture hash (SHA-256, OBS-003): ${fixtureHash}`);
console.log('');
if (errors.length) {
  console.error(`FAIL: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('PASS: structural validation succeeded. (Structure only: linguistic quality still requires native/fluent human review; see README.md.)');
