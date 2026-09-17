#!/usr/bin/env node
// CycloneDX 1.5 JSON SBOM from package-lock.json (REL-002). No network, no
// dependencies; licence identifiers come from node_modules when installed,
// else from the lockfile.
//
//   node tools/release/generate-sbom.mjs [--include-dev] [--check]
//        [--out docs/releases/v1/sbom/namu-npm.cdx.json]
//
// Default scope is the production closure (dependencies + optional + installed
// peers). --include-dev adds every other locked package with scope "excluded"
// (CycloneDX: present for build/test, not part of the runtime).
//
// The output is reproducible: no timestamp, and the serial number is derived
// from the lockfile hash, so CI can diff it (--check). The build record
// (tools/release/build-record.mjs) carries the time and commit instead.
//
// Scope: npm only. CocoaPods (Podfile.lock) and Gradle dependencies need their
// own SBOMs from the platform build; they are not produced here.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {
  declaredLicense,
  edgesOf,
  nameFromLocation,
  productionClosure,
  purl,
  readLock,
  repoRoot,
} from './lock-closure.mjs';

const SPDX_ID = /^[A-Za-z0-9.+-]+$/;

function hashesFromIntegrity(integrity) {
  const algorithms = {sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1'};
  return (integrity ?? '').split(/\s+/).filter(Boolean).flatMap(token => {
    const dash = token.indexOf('-');
    const alg = algorithms[token.slice(0, dash)];
    return alg ? [{alg, content: Buffer.from(token.slice(dash + 1), 'base64').toString('hex')}] : [];
  });
}

function licensesFor(expression) {
  if (!expression) {
    return undefined;
  }
  return SPDX_ID.test(expression) ? [{license: {id: expression}}] : [{expression}];
}

function uuidFrom(hex) {
  // RFC 4122 layout with version 5 / variant bits set, from a SHA-256 prefix.
  const h = hex.slice(0, 32).split('');
  h[12] = '5';
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export function buildSbom({lock, lockSha256, includeDev = false, nodeModulesRoot = repoRoot}) {
  const closure = productionClosure(lock);
  const production = new Set(closure.locations);
  const locations = includeDev
    ? Object.keys(lock.packages).filter(l => l !== '' && !lock.packages[l].link).sort()
    : closure.locations;

  const refOf = location => {
    const entry = lock.packages[location];
    return purl(nameFromLocation(location), entry.version);
  };
  const components = new Map(); // bom-ref -> component (same name@version installed twice = one component)
  for (const location of locations) {
    const entry = lock.packages[location];
    const name = nameFromLocation(location);
    const ref = refOf(location);
    if (components.has(ref)) {
      if (production.has(location)) {
        components.get(ref).scope = entry.optional ? components.get(ref).scope : 'required';
      }
      continue;
    }
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(nodeModulesRoot, location, 'package.json'), 'utf8'));
    } catch {
      manifest = null;
    }
    const scoped = name.startsWith('@');
    const component = {
      type: 'library',
      'bom-ref': ref,
      ...(scoped ? {group: name.slice(0, name.indexOf('/'))} : {}),
      name: scoped ? name.slice(name.indexOf('/') + 1) : name,
      version: entry.version,
      scope: !production.has(location) ? 'excluded' : entry.optional ? 'optional' : 'required',
      purl: ref,
    };
    const hashes = hashesFromIntegrity(entry.integrity);
    if (hashes.length > 0) {
      component.hashes = hashes;
    }
    const licenses = licensesFor(declaredLicense(manifest, entry));
    if (licenses) {
      component.licenses = licenses;
    }
    if (typeof entry.resolved === 'string' && /^https?:/.test(entry.resolved)) {
      component.externalReferences = [{type: 'distribution', url: entry.resolved}];
    }
    components.set(ref, component);
  }

  const root = lock.packages[''];
  const rootRef = purl(root.name ?? lock.name, root.version ?? lock.version);
  const dependsOn = new Map([[rootRef, new Set()]]);
  for (const location of ['', ...locations]) {
    const from = location === '' ? rootRef : refOf(location);
    const set = dependsOn.get(from) ?? new Set();
    const targets = closure.edges.get(location) ?? edgesOf(lock.packages, location).targets;
    const rootDev = includeDev && location === '' ? edgesOf(lock.packages, '', {includeDev: true}).targets : [];
    for (const target of [...targets, ...rootDev]) {
      if (refOf(target) !== from && components.has(refOf(target))) {
        set.add(refOf(target));
      }
    }
    dependsOn.set(from, set);
  }

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${uuidFrom(lockSha256)}`,
    version: 1,
    metadata: {
      tools: [{vendor: 'Namu', name: 'tools/release/generate-sbom.mjs', version: '1'}],
      component: {
        type: 'application',
        'bom-ref': rootRef,
        name: root.name ?? lock.name,
        version: root.version ?? lock.version,
        purl: rootRef,
      },
      properties: [
        {name: 'namu:package-lock.sha256', value: lockSha256},
        {name: 'namu:scope', value: includeDev ? 'production closure + dev (scope=excluded)' : 'production closure'},
      ],
    },
    components: [...components.values()].sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref'], 'en')),
    dependencies: [...dependsOn.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'en'))
      .map(([ref, targets]) => ({ref, dependsOn: [...targets].sort((a, b) => a.localeCompare(b, 'en'))})),
  };
}

/** Structural self-check of the document we emit (not a full schema validation). */
export function sbomProblems(bom) {
  const problems = [];
  if (bom.bomFormat !== 'CycloneDX' || bom.specVersion !== '1.5') {
    problems.push('bomFormat/specVersion');
  }
  if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(bom.serialNumber)) {
    problems.push('serialNumber is not a urn:uuid');
  }
  const refs = new Set([bom.metadata.component['bom-ref']]);
  for (const c of bom.components) {
    if (refs.has(c['bom-ref'])) {
      problems.push(`duplicate bom-ref ${c['bom-ref']}`);
    }
    refs.add(c['bom-ref']);
    if (!c.name || !c.version || !c.purl?.startsWith('pkg:npm/')) {
      problems.push(`incomplete component ${c['bom-ref']}`);
    }
    if (!['required', 'optional', 'excluded'].includes(c.scope)) {
      problems.push(`bad scope on ${c['bom-ref']}`);
    }
    for (const h of c.hashes ?? []) {
      if (!/^[0-9a-f]+$/.test(h.content)) {
        problems.push(`bad hash on ${c['bom-ref']}`);
      }
    }
  }
  for (const d of bom.dependencies) {
    for (const ref of [d.ref, ...d.dependsOn]) {
      if (!refs.has(ref)) {
        problems.push(`dependency graph names unknown ref ${ref}`);
      }
    }
  }
  return problems;
}

function main() {
  const {values: args} = parseArgs({
    options: {
      out: {type: 'string', default: path.join(repoRoot, 'docs/releases/v1/sbom/namu-npm.cdx.json')},
      'include-dev': {type: 'boolean', default: false},
      check: {type: 'boolean', default: false},
    },
  });
  const {lock, sha256} = readLock();
  const bom = buildSbom({lock, lockSha256: sha256, includeDev: args['include-dev']});
  const problems = sbomProblems(bom);
  if (problems.length > 0) {
    throw new Error(`generated SBOM is inconsistent:\n  - ${problems.slice(0, 20).join('\n  - ')}`);
  }
  const json = JSON.stringify(bom, null, 2) + '\n';
  const withoutLicence = bom.components.filter(c => !c.licenses).length;
  console.log(`components: ${bom.components.length} (without licence data: ${withoutLicence}), ` +
    `dependency entries: ${bom.dependencies.length}`);
  if (args.check) {
    const current = fs.existsSync(args.out) ? fs.readFileSync(args.out, 'utf8') : '';
    if (current !== json) {
      console.error(`${path.relative(repoRoot, args.out)} is out of date; run node tools/release/generate-sbom.mjs`);
      process.exitCode = 1;
    }
    return;
  }
  fs.mkdirSync(path.dirname(args.out), {recursive: true});
  fs.writeFileSync(args.out, json);
  console.log(`wrote ${path.relative(repoRoot, args.out)} (${Buffer.byteLength(json)} bytes), ` +
    `sha256 ${crypto.createHash('sha256').update(json).digest('hex')}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
