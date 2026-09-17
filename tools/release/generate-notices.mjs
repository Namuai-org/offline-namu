#!/usr/bin/env node
// Third-party notices for the npm production dependency closure (REL-002).
//
//   node tools/release/generate-notices.mjs [--check] [--out docs/notices/THIRD_PARTY_NOTICES.md]
//
// Walks package-lock.json from the production dependencies (never
// devDependencies), reads each package's declared licence and licence/notice
// files from node_modules, and writes one deterministic Markdown file. For the
// direct dependencies it also collects licence files of vendored native code
// (for example llama.rn/cpp/LICENSE). No network access.
//
// Exit status 1 when any package is FLAGGED:
//   - no licence declared, UNLICENSED, or "SEE LICENSE IN ..." (unknown terms)
//   - GPL / AGPL / LGPL with no permissive alternative in an OR expression
// unless tools/release/license-decisions.json records an owner decision:
//   {"name@version": {"decision": "accepted", "reason": "...", "by": "..."}}
// The output file is written either way so the findings can be reviewed.
// --check writes nothing and fails if the committed file is out of date.
//
// Scope: npm packages only. CocoaPods/Gradle dependencies, fonts, icons and
// the model licence notice are inventoried separately (docs/notices/).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {
  declaredLicense,
  flagClosure,
  nameFromLocation,
  productionClosure,
  readLock,
  repoRoot,
} from './lock-closure.mjs';

const LICENCE_FILE = /^(licen[sc]e|licen[sc]e-[\w.-]+|copying|copyright|notice|unlicense)(\.(md|txt|markdown|rst|mit|bsd|apache|apache2))?$/i;
const PERMISSIVE = new Set(['MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0',
  'CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'Unlicense', 'BlueOak-1.0.0', 'Python-2.0', 'Zlib', 'WTFPL']);
const COPYLEFT = /\b(A|L)?GPL\b/i;

/** @returns {{status: 'ok'|'review'|'flagged', reason: string, effective: string|null}} */
export function classify(expression) {
  if (!expression) {
    return {status: 'flagged', reason: 'no licence declared', effective: null};
  }
  if (/^UNLICENSED$/i.test(expression) || /^SEE LICEN[SC]E IN/i.test(expression)) {
    return {status: 'flagged', reason: `unknown terms: "${expression}"`, effective: null};
  }
  const bare = expression.replace(/^\((.*)\)$/, '$1');
  const alternatives = bare.split(/\s+OR\s+/i).map(s => s.trim().replace(/^\((.*)\)$/, '$1'));
  const acceptable = alternatives.filter(alt => alt.split(/\s+AND\s+/i).every(id => !COPYLEFT.test(id)));
  if (acceptable.length === 0) {
    return {status: 'flagged', reason: `copyleft: "${expression}"`, effective: null};
  }
  const permissive = acceptable.find(alt => alt.split(/\s+AND\s+/i).every(id => PERMISSIVE.has(id.trim())));
  if (permissive) {
    return {status: 'ok', reason: alternatives.length > 1 ? `chosen from "${expression}"` : '', effective: permissive};
  }
  return {status: 'review', reason: `not on the permissive list: "${expression}"`, effective: acceptable[0]};
}

function licenceFilesIn(dir, relativeTo, depth) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, {withFileTypes: true});
  } catch {
    return found;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && LICENCE_FILE.test(entry.name)) {
      found.push(path.relative(relativeTo, full));
    } else if (entry.isDirectory() && depth > 0 &&
        !['node_modules', 'test', 'tests', '__tests__', 'example', 'examples', 'docs', '.git'].includes(entry.name)) {
      found.push(...licenceFilesIn(full, relativeTo, depth - 1));
    }
  }
  return found;
}

function normalizeText(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

function fence(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(m => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}text\n${text}\n${ticks}`;
}

function repositoryUrl(manifest) {
  const repo = manifest?.repository;
  const raw = typeof repo === 'string' ? repo : repo?.url;
  if (typeof raw !== 'string' || raw === '') {
    return typeof manifest?.homepage === 'string' ? manifest.homepage : '';
  }
  return raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://').replace(/^github:/, 'https://github.com/');
}

export function collect({lock, nodeModulesRoot = repoRoot}) {
  const closure = productionClosure(lock);
  const direct = new Set(Object.keys(lock.packages[''].dependencies ?? {}).map(name => `node_modules/${name}`));
  const packages = closure.locations.map(location => {
    const entry = lock.packages[location];
    const dir = path.join(nodeModulesRoot, location);
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      manifest = null; // optional platform package that is not installed here
    }
    const name = nameFromLocation(location);
    const expression = declaredLicense(manifest, entry);
    const files = manifest ? licenceFilesIn(dir, dir, direct.has(location) ? 3 : 0) : [];
    return {
      id: `${name}@${entry.version}`, name, version: entry.version, location,
      installed: manifest !== null, optional: Boolean(entry.optional), direct: direct.has(location),
      expression, classification: classify(expression), repository: repositoryUrl(manifest),
      texts: files.map(file => ({file, text: normalizeText(fs.readFileSync(path.join(dir, file), 'utf8'))}))
        .filter(t => t.text !== ''),
    };
  });
  // One entry per name@version (the same version can be installed in several places).
  const byId = new Map();
  for (const pkg of packages) {
    const existing = byId.get(pkg.id);
    if (!existing || (!existing.installed && pkg.installed) || (pkg.texts.length > existing.texts.length)) {
      byId.set(pkg.id, {...pkg, direct: pkg.direct || Boolean(existing?.direct)});
    }
  }
  const unique = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'en') ||
    a.version.localeCompare(b.version, 'en', {numeric: true}));
  return {closure, packages: unique};
}

export function render({packages, lockSha256, decisions}) {
  const texts = new Map(); // sha256(text) -> {label, text, users[]}
  for (const pkg of packages) {
    for (const t of pkg.texts) {
      const key = crypto.createHash('sha256').update(t.text).digest('hex');
      if (!texts.has(key)) {
        texts.set(key, {text: t.text, users: []});
      }
      texts.get(key).users.push(`${pkg.id}${t.file.includes(path.sep) || t.file.includes('/') ? ` (${t.file})` : ''}`);
      t.key = key;
    }
  }
  const ordered = [...texts.entries()].sort((a, b) => a[1].users[0].localeCompare(b[1].users[0], 'en'));
  ordered.forEach(([, value], index) => {
    value.label = `T${String(index + 1).padStart(3, '0')}`;
  });

  const flagged = packages.filter(p => p.classification.status === 'flagged');
  const review = packages.filter(p => p.classification.status === 'review');
  const noText = packages.filter(p => p.texts.length === 0);
  const byLicence = new Map();
  for (const pkg of packages) {
    const key = pkg.expression ?? '(none declared)';
    byLicence.set(key, (byLicence.get(key) ?? 0) + 1);
  }

  const out = [];
  out.push('# Third-party notices — npm production dependencies', '');
  out.push('Generated by `node tools/release/generate-notices.mjs`. Do not edit by hand.', '');
  out.push(`- package-lock.json SHA-256: \`${lockSha256}\``);
  out.push(`- packages (unique name@version) in the production closure: ${packages.length}`);
  out.push(`- distinct licence/notice texts reproduced below: ${ordered.length}`);
  out.push('- scope: npm packages reachable from `dependencies` (optional and peer packages included,',
    '  `devDependencies` excluded). This is a superset of what is bundled into the app: build-time',
    '  packages that `react-native` itself depends on are listed too. CocoaPods and Gradle',
    '  dependencies, fonts, icons and the model licence are covered by their own notices.', '');

  out.push('## Licence summary', '', '| Declared licence | Packages |', '|---|---:|');
  for (const [licence, count] of [...byLicence.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))) {
    out.push(`| ${licence} | ${count} |`);
  }
  out.push('');

  out.push('## Flagged: unknown, missing or copyleft licences', '');
  if (flagged.length === 0) {
    out.push('None.', '');
  } else {
    out.push('| Package | Declared | Finding | Owner decision |', '|---|---|---|---|');
    for (const pkg of flagged) {
      const d = decisions[pkg.id];
      out.push(`| ${pkg.id} | ${pkg.expression ?? '—'} | ${pkg.classification.reason} | ${d ? `${d.decision}: ${d.reason} (${d.by ?? 'unattributed'})` : '**none recorded**'} |`);
    }
    out.push('');
  }

  out.push('## Needs review: not on the permissive list', '');
  if (review.length === 0) {
    out.push('None.', '');
  } else {
    out.push('| Package | Declared |', '|---|---|');
    for (const pkg of review) {
      out.push(`| ${pkg.id} | ${pkg.expression} |`);
    }
    out.push('');
  }

  out.push('## Packages without a licence file in the package', '');
  if (noText.length === 0) {
    out.push('None.', '');
  } else {
    out.push('The declared licence applies; the package ships no licence text of its own.', '');
    for (const pkg of noText) {
      out.push(`- ${pkg.id} — ${pkg.expression ?? 'no licence declared'}${pkg.installed ? '' : ' (optional platform package, not installed where this file was generated)'}`);
    }
    out.push('');
  }

  out.push('## Packages', '', '| Package | Version | Licence | Text | Source |', '|---|---|---|---|---|');
  for (const pkg of packages) {
    const labels = [...new Set(pkg.texts.map(t => texts.get(t.key).label))].join(', ') || '—';
    out.push(`| ${pkg.name}${pkg.direct ? ' **(direct)**' : ''} | ${pkg.version} | ${pkg.expression ?? '—'} | ${labels} | ${pkg.repository} |`);
  }
  out.push('');

  out.push('## Licence and notice texts', '');
  for (const [, value] of ordered) {
    out.push(`### ${value.label}`, '', `Applies to: ${value.users.join(', ')}`, '', fence(value.text), '');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

function main() {
  const {values: args} = parseArgs({
    options: {
      out: {type: 'string', default: path.join(repoRoot, 'docs/notices/THIRD_PARTY_NOTICES.md')},
      check: {type: 'boolean', default: false},
    },
  });
  const {lock, sha256} = readLock();
  if (!fs.existsSync(path.join(repoRoot, 'node_modules'))) {
    throw new Error('node_modules is missing; run `npm ci` first (licence texts are read from the installed packages)');
  }
  const decisionsFile = path.join(repoRoot, 'tools/release/license-decisions.json');
  const decisions = fs.existsSync(decisionsFile) ? JSON.parse(fs.readFileSync(decisionsFile, 'utf8')) : {};
  const {closure, packages} = collect({lock});
  const markdown = render({packages, lockSha256: sha256, decisions});

  const byFlags = flagClosure(lock);
  const onlyWalk = closure.locations.filter(l => !byFlags.includes(l));
  const onlyFlags = byFlags.filter(l => !closure.locations.includes(l));
  console.log(`production closure: ${closure.locations.length} installed locations, ${packages.length} unique packages`);
  if (onlyWalk.length > 0 || onlyFlags.length > 0) {
    console.log(`note: walk and npm "dev" flags disagree (walk only: ${onlyWalk.length}, flags only: ${onlyFlags.length})`);
    for (const l of onlyFlags) {
      console.log(`  flags only: ${l}`);
    }
    for (const l of onlyWalk) {
      console.log(`  walk only:  ${l}`);
    }
  }
  for (const miss of closure.unresolved) {
    console.log(`warning: unresolved required dependency ${miss}`);
  }

  if (args.check) {
    const current = fs.existsSync(args.out) ? fs.readFileSync(args.out, 'utf8') : '';
    if (current !== markdown) {
      console.error(`${path.relative(repoRoot, args.out)} is out of date; run node tools/release/generate-notices.mjs`);
      process.exitCode = 1;
    }
  } else {
    fs.mkdirSync(path.dirname(args.out), {recursive: true});
    fs.writeFileSync(args.out, markdown);
    console.log(`wrote ${path.relative(repoRoot, args.out)} (${Buffer.byteLength(markdown)} bytes)`);
  }

  const review = packages.filter(p => p.classification.status === 'review');
  for (const pkg of review) {
    console.log(`review:  ${pkg.id}  ${pkg.expression}`);
  }
  const undecided = packages.filter(p => p.classification.status === 'flagged' && decisions[p.id]?.decision !== 'accepted');
  for (const pkg of packages.filter(p => p.classification.status === 'flagged')) {
    console.log(`FLAGGED: ${pkg.id}  ${pkg.classification.reason}${decisions[pkg.id] ? `  [decision: ${decisions[pkg.id].decision}]` : ''}`);
  }
  console.log(`packages without a licence file: ${packages.filter(p => p.texts.length === 0).length}`);
  if (undecided.length > 0) {
    console.error(`${undecided.length} flagged package(s) without an accepted owner decision`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
