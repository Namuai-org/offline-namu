#!/usr/bin/env node
/**
 * Repository boundary check (PRD section 4, ARC-001, ARC-004, SEC-003,
 * NFR-012). Fails the build when:
 *  - llama.rn is imported outside src/infrastructure/inference/
 *  - op-sqlite is imported outside src/infrastructure/db/
 *  - UI code (features/design) imports infrastructure, performs SQL, or
 *    touches native specs
 *  - domain code depends on React Native, features or infrastructure
 *  - any JS source performs network I/O (fetch/XHR/WebSocket): the only
 *    network code in the product is the native transfer service
 *  - an analytics / crash-reporting / cloud-inference SDK is a dependency
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const src = path.join(root, 'src');
const errors = [];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const importPattern = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;

for (const file of walk(src)) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  const text = fs.readFileSync(file, 'utf8');
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const imports = [...code.matchAll(importPattern)].map(m => m[1] || m[2] || m[3]);
  const resolved = imports.map(spec =>
    spec.startsWith('.') ? path.relative(root, path.resolve(path.dirname(file), spec)).split(path.sep).join('/') : spec,
  );
  const inDir = dir => rel.startsWith(`src/${dir}/`);

  for (const spec of resolved) {
    if ((spec === 'llama.rn' || spec.startsWith('llama.rn/')) && !inDir('infrastructure/inference')) {
      errors.push(`${rel}: llama.rn may only be imported in src/infrastructure/inference/`);
    }
    if (spec.startsWith('@op-engineering/op-sqlite') && !inDir('infrastructure/db')) {
      errors.push(`${rel}: op-sqlite may only be imported in src/infrastructure/db/`);
    }
    if ((inDir('features') || inDir('design')) && spec.startsWith('src/infrastructure/')) {
      errors.push(`${rel}: UI code must not import infrastructure (${spec})`);
    }
    if (inDir('design') && (spec.startsWith('src/features/') || spec.startsWith('src/data/') || spec.startsWith('src/app/'))) {
      errors.push(`${rel}: design system must not depend on ${spec}`);
    }
    if (inDir('domain') && (spec === 'react-native' || spec === 'react' || spec.startsWith('src/features/') ||
        spec.startsWith('src/infrastructure/') || spec.startsWith('src/app/') || spec.startsWith('src/design/'))) {
      errors.push(`${rel}: domain code must stay platform-free (${spec})`);
    }
    if (inDir('data') && (spec === 'react-native' || spec.startsWith('src/features/') || spec.startsWith('src/infrastructure/') || spec.startsWith('src/app/'))) {
      errors.push(`${rel}: data layer must not depend on ${spec}`);
    }
  }

  if (inDir('features') || inDir('design')) {
    if (/\b(SELECT|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/.test(code)) {
      errors.push(`${rel}: components must not perform SQL`);
    }
    if (/\.(execute|transaction)\(/.test(code)) {
      errors.push(`${rel}: components must call repositories, not the database`);
    }
    if (/MODEL_ORIGIN|resolveArtifactPath|file:\/\//.test(code)) {
      errors.push(`${rel}: components must not build model URLs or use native file paths`);
    }
  }

  if (/\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|EventSource\(|navigator\.sendBeacon/.test(code)) {
    errors.push(`${rel}: JS network I/O is not allowed (SEC-003); only the native transfer service uses the network`);
  }
  if (/<Image[^>]*source=\{\{\s*uri:/.test(code)) {
    errors.push(`${rel}: remote images are not allowed (SEC-003)`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const forbidden = /sentry|firebase|crashlytics|analytics|amplitude|mixpanel|segment|bugsnag|datadog|posthog|appcenter|openai|anthropic|codepush/i;
for (const name of Object.keys({...pkg.dependencies})) {
  if (forbidden.test(name)) {
    errors.push(`package.json: dependency "${name}" is not allowed (no telemetry, no cloud inference)`);
  }
}
for (const [name, version] of Object.entries({...pkg.dependencies, ...pkg.devDependencies})) {
  if (/^[\^~]|^[<>*]|x$/.test(version)) {
    errors.push(`package.json: "${name}" must be pinned to an exact version (STK-001), found ${version}`);
  }
}
if (pkg.dependencies['llama.rn'] !== '0.12.9') {
  errors.push('package.json: llama.rn must be exactly 0.12.9 (STK-002)');
}
if (pkg.dependencies['react-native'] !== '0.86.0') {
  errors.push('package.json: react-native must be exactly 0.86.0');
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('architecture boundaries hold');
