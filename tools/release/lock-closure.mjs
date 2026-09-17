// Shared by generate-notices.mjs and generate-sbom.mjs: the production
// dependency closure of package-lock.json (lockfileVersion 2 or 3). No network.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function readLock(lockFile = path.join(repoRoot, 'package-lock.json')) {
  const bytes = fs.readFileSync(lockFile);
  const lock = JSON.parse(bytes.toString('utf8'));
  if (![2, 3].includes(lock.lockfileVersion) || typeof lock.packages !== 'object') {
    throw new Error(`${lockFile}: lockfileVersion 2 or 3 with a "packages" map is required`);
  }
  return {lock, sha256: crypto.createHash('sha256').update(bytes).digest('hex')};
}

/** "node_modules/a/node_modules/@s/b" -> "@s/b" */
export function nameFromLocation(location) {
  return location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

/** Node resolution: nearest node_modules first, then each enclosing package, then the root. */
export function resolveDependency(packages, fromLocation, name) {
  let dir = fromLocation;
  for (;;) {
    const candidate = dir === '' ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (packages[candidate]) {
      return candidate;
    }
    if (dir === '') {
      return null;
    }
    const cut = dir.lastIndexOf('/node_modules/');
    dir = cut === -1 ? '' : dir.slice(0, cut);
  }
}

/**
 * Resolved dependency locations of one installed package. Follows
 * dependencies, optionalDependencies and peerDependencies (optional and peer
 * packages may legitimately be absent); devDependencies only when asked, and
 * only meaningful for the root.
 * @returns {{targets: string[], unresolved: string[]}}
 */
export function edgesOf(packages, location, {includeDev = false} = {}) {
  const entry = packages[location];
  const required = Object.keys(entry.dependencies ?? {});
  const mayBeAbsent = new Set([
    ...Object.keys(entry.optionalDependencies ?? {}),
    ...Object.keys(entry.peerDependencies ?? {}),
  ]);
  const dev = includeDev ? Object.keys(entry.devDependencies ?? {}) : [];
  const targets = new Set();
  const unresolved = [];
  for (const name of new Set([...required, ...mayBeAbsent, ...dev])) {
    const target = resolveDependency(packages, location, name);
    if (target === null) {
      if (!mayBeAbsent.has(name)) {
        unresolved.push(`${location || '(root)'} -> ${name}`);
      }
    } else if (!packages[target].link) {
      targets.add(target); // workspace links are first-party code
    }
  }
  return {targets: [...targets].sort(), unresolved};
}

/**
 * The production closure: everything reachable from the root without ever
 * following devDependencies.
 * @returns {{locations: string[], edges: Map<string, string[]>, unresolved: string[]}}
 *   locations are sorted; edges map a location ('' = root) to resolved locations.
 */
export function productionClosure(lock) {
  const edges = new Map();
  const unresolved = [];
  const seen = new Set();
  const queue = [''];
  while (queue.length > 0) {
    const location = queue.shift();
    const result = edgesOf(lock.packages, location);
    unresolved.push(...result.unresolved);
    edges.set(location, result.targets);
    for (const target of result.targets) {
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return {locations: [...seen].sort(), edges, unresolved};
}

/** Consistency check against npm's own flags: production = not dev-only. */
export function flagClosure(lock) {
  return Object.entries(lock.packages)
    .filter(([location, entry]) => location !== '' && !entry.dev && !entry.link)
    .map(([location]) => location)
    .sort();
}

export function purl(name, version) {
  const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

/** Normalizes package.json licence declarations to one SPDX-ish string, or null. */
export function declaredLicense(manifest, lockEntry) {
  const from = value => {
    if (typeof value === 'string') {
      return value.trim() || null;
    }
    if (value && typeof value === 'object' && typeof value.type === 'string') {
      return value.type.trim() || null;
    }
    return null;
  };
  if (manifest) {
    const single = from(manifest.license);
    if (single) {
      return single;
    }
    if (Array.isArray(manifest.licenses)) {
      const many = manifest.licenses.map(from).filter(Boolean);
      if (many.length > 0) {
        return many.length === 1 ? many[0] : `(${many.join(' OR ')})`;
      }
    }
  }
  return from(lockEntry?.license);
}
