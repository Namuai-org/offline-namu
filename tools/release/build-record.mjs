#!/usr/bin/env node
// REL-003 release build record. Collects hashes of the inputs that define a
// build; it never invents a value: anything that is not present is reported as
// null and listed under "missing". No network.
//
//   node tools/release/build-record.mjs --out build-record.json [--strict]
//     [--descriptor <signed envelope used as the bundled initial descriptor>]
//     [--db-schema-version <n>] [--app-build <n>]
//     [--evidence tests=<file> --evidence language-review=<file> --evidence devices=<file>]...
//
// --strict exits 1 when anything REL-003 requires is missing (release builds).
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {PROMPT_VERSION} from '../../model-release/descriptor/sign.mjs';
import {repoRoot} from './lock-closure.mjs';

const REQUIRED_EVIDENCE = ['tests', 'language-review', 'devices'];

function sha256OfFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fileEntry(relative) {
  const file = path.resolve(repoRoot, relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return null;
  }
  return {path: path.relative(repoRoot, file), bytes: fs.statSync(file).size, sha256: sha256OfFile(file)};
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    const entry = fileEntry(candidate);
    if (entry) {
      return entry;
    }
  }
  return null;
}

function git(args) {
  try {
    return execFileSync('git', args, {cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
  } catch {
    return null;
  }
}

function filesUnder(relativeDir) {
  const dir = path.join(repoRoot, relativeDir);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, {recursive: true})
    .map(name => path.join(relativeDir, name))
    .filter(relative => fs.statSync(path.join(repoRoot, relative)).isFile())
    .sort()
    .map(fileEntry);
}

export function buildRecord({descriptor = null, dbSchemaVersion = null, appBuild = null, evidence = {}} = {}) {
  const missing = [];
  const need = (label, value) => {
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
      missing.push(label);
    }
    return value ?? null;
  };

  const commit = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain']);
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const modelLockEntry = fileEntry('model-release/model.lock.json');
  const evidenceEntries = {};
  for (const name of new Set([...REQUIRED_EVIDENCE, ...Object.keys(evidence)])) {
    evidenceEntries[name] = need(`evidence: ${name}`, evidence[name] ? fileEntry(evidence[name]) : null);
  }

  const record = {
    record_schema: 1,
    requirement: 'REL-003',
    generated_at: new Date().toISOString(),
    app: {
      name: packageJson.name,
      version: packageJson.version,
      build: appBuild,
      commit: need('app commit (git rev-parse HEAD)', commit),
      working_tree_clean: status === null ? null : status === '',
    },
    toolchain_lock: need('toolchain.lock.md (STK-001)',
      firstExisting(['toolchain.lock.md', 'docs/toolchain.lock.md', 'docs/engineering/toolchain.lock.md'])),
    dependency_locks: {
      npm: need('package-lock.json', fileEntry('package-lock.json')),
      cocoapods: need('ios/Podfile.lock', fileEntry('ios/Podfile.lock')),
      gradle_wrapper: need('android/gradle/wrapper/gradle-wrapper.properties',
        fileEntry('android/gradle/wrapper/gradle-wrapper.properties')),
      gradle_verification: need('android/gradle/verification-metadata.xml (STK-001)',
        fileEntry('android/gradle/verification-metadata.xml')),
    },
    runtime: {
      'llama.rn': packageJson.dependencies?.['llama.rn'] ?? null,
      native_patches: filesUnder('patches'), // empty means the pinned runtime is unpatched (INF-001)
    },
    model: {
      lock: need('model-release/model.lock.json (MDL-003)', modelLockEntry),
      lock_content: modelLockEntry ? JSON.parse(fs.readFileSync(path.join(repoRoot, modelLockEntry.path), 'utf8')) : null,
      release_tool_requirements: need('model-release/requirements.lock.txt', fileEntry('model-release/requirements.lock.txt')),
      signed_descriptor: need('signed descriptor (--descriptor)', descriptor ? fileEntry(descriptor) : null),
    },
    prompt_version: PROMPT_VERSION,
    db_schema_version: need('chat DB schema version (--db-schema-version)', dbSchemaVersion),
    sbom: need('docs/releases/v1/sbom/namu-npm.cdx.json', fileEntry('docs/releases/v1/sbom/namu-npm.cdx.json')),
    third_party_notices: need('docs/notices/THIRD_PARTY_NOTICES.md', fileEntry('docs/notices/THIRD_PARTY_NOTICES.md')),
    evidence: evidenceEntries,
    missing: [],
  };
  if (record.app.working_tree_clean === false) {
    missing.push('clean working tree (REL-003: build from a clean checkout)');
  }
  record.missing = missing;
  return record;
}

function main() {
  const {values: args} = parseArgs({
    options: {
      out: {type: 'string'},
      strict: {type: 'boolean', default: false},
      descriptor: {type: 'string'},
      'db-schema-version': {type: 'string'},
      'app-build': {type: 'string'},
      evidence: {type: 'string', multiple: true},
    },
  });
  const evidence = {};
  for (const item of args.evidence ?? []) {
    const eq = item.indexOf('=');
    if (eq < 1) {
      throw new Error(`--evidence expects name=path, got "${item}"`);
    }
    evidence[item.slice(0, eq)] = item.slice(eq + 1);
  }
  const toInt = (value, flag) => {
    if (value === undefined) {
      return null;
    }
    if (!/^\d+$/.test(value)) {
      throw new Error(`${flag} must be a non-negative integer`);
    }
    return Number(value);
  };
  const record = buildRecord({
    descriptor: args.descriptor ?? null,
    dbSchemaVersion: toInt(args['db-schema-version'], '--db-schema-version'),
    appBuild: toInt(args['app-build'], '--app-build'),
    evidence,
  });
  const json = JSON.stringify(record, null, 2) + '\n';
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), {recursive: true});
    fs.writeFileSync(args.out, json);
    console.log(`wrote ${args.out}`);
  } else {
    process.stdout.write(json);
  }
  if (record.missing.length > 0) {
    console.error(`REL-003 record incomplete (${record.missing.length}):\n  - ${record.missing.join('\n  - ')}`);
    if (args.strict) {
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
