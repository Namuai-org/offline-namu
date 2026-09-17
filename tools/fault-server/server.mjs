#!/usr/bin/env node
// Namu fault-injection file server (PRD section 20: T03-T07, T12; milestone M3).
//
//   node tools/fault-server/server.mjs [--root model-release/dev/out/serve]
//        [--port 8787] [--host 127.0.0.1] [--alt-port 8788]
//        [--fault '<json rule>']... [--faults-file rules.json]
//
// A correct origin by default: GET and HEAD only, strong SHA-256 ETag, exact
// Content-Length, Accept-Ranges, single-range and If-Range semantics per
// RFC 9110 (206 / 200 / 416). Faults are opt-in rules matched per request
// path; see README.md for the rule format and the recipe for each PRD test.
//
// Development tool only. It has no dependencies, serves one directory
// read-only, and never logs query strings.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(here, '../../model-release/dev/out/serve');
export const CONTROL_PATH = '/__faults';

const MAX_CONTROL_BODY = 64 * 1024;
const MAX_LOG_ENTRIES = 500;
const READ_CHUNK = 64 * 1024;
const FILLER = Buffer.alloc(READ_CHUNK, 0xaa);

export const FAULTS = [
  'drop', 'truncate', 'ignore-range', 'wrong-content-range', 'change-etag',
  'status-416', 'oversize', 'endless', 'throttle', 'status', 'redirect', 'gzip',
];

// --------------------------------------------------------------------------
// Range and If-Range (RFC 9110 sections 13.1.5, 14.1.2, 14.2)
// --------------------------------------------------------------------------

/**
 * @returns {{kind: 'none'} | {kind: 'unsatisfiable'} | {kind: 'range', start: number, end: number}}
 * 'none' means "serve the whole representation": no header, another range
 * unit, invalid syntax or a multi-range request, all of which a server may
 * ignore.
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') {
    return {kind: 'none'};
  }
  const m = /^bytes=\s*(\d{0,18})-(\d{0,18})\s*$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) {
    return {kind: 'none'};
  }
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) {
      return {kind: 'unsatisfiable'};
    }
    return {kind: 'range', start: Math.max(0, size - suffix), end: size - 1};
  }
  const start = Number(m[1]);
  const last = m[2] === '' ? Infinity : Number(m[2]);
  if (last < start) {
    return {kind: 'none'};
  }
  if (start >= size) {
    return {kind: 'unsatisfiable'};
  }
  return {kind: 'range', start, end: Math.min(last, size - 1)};
}

/** Strong comparison only: a weak validator or an HTTP-date never matches. */
export function ifRangeMatches(header, currentEtag) {
  if (typeof header !== 'string') {
    return true; // no precondition
  }
  const value = header.trim();
  return !value.startsWith('W/') && value === currentEtag;
}

export function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// --------------------------------------------------------------------------
// Fault rules
// --------------------------------------------------------------------------

function isInt(v, min, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(v) && v >= min && v <= max;
}

function patternToRegExp(pattern) {
  const escaped = pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`);
}

/** Validates one rule and returns its normalized form; throws on any error. */
export function normalizeRule(raw, {hasAltPort = false} = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('a rule must be a JSON object');
  }
  const known = new Set(['match', 'fault', 'times', 'whenRange', 'methods', 'percent',
    'afterBytes', 'variant', 'ifRange', 'bytesPerSecond', 'code', 'retryAfter',
    'location', 'altPort', 'extraBytes', 'declareLength', 'maxBytes']);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw new Error(`unknown rule field "${key}"`);
    }
  }
  const rule = {match: raw.match ?? '*', fault: raw.fault};
  if (typeof rule.match !== 'string' || !(rule.match === '*' || rule.match.startsWith('/'))) {
    throw new Error('match must be "*" or a path pattern starting with "/"');
  }
  if (!FAULTS.includes(rule.fault)) {
    throw new Error(`fault must be one of: ${FAULTS.join(', ')}`);
  }
  if (raw.times !== undefined && raw.times !== null) {
    if (!isInt(raw.times, 1)) {
      throw new Error('times must be a positive integer (omit for unlimited)');
    }
    rule.times = raw.times;
  }
  if (raw.whenRange !== undefined) {
    if (typeof raw.whenRange !== 'boolean') {
      throw new Error('whenRange must be a boolean');
    }
    rule.whenRange = raw.whenRange;
  }
  rule.methods = raw.methods ?? ['GET'];
  if (!Array.isArray(rule.methods) || rule.methods.length === 0 ||
      !rule.methods.every(m => m === 'GET' || m === 'HEAD')) {
    throw new Error('methods must be a non-empty array of "GET" and/or "HEAD"');
  }

  switch (rule.fault) {
    case 'drop':
    case 'truncate': {
      const hasPercent = raw.percent !== undefined;
      const hasBytes = raw.afterBytes !== undefined;
      if (hasPercent === hasBytes) {
        throw new Error(`${rule.fault} needs exactly one of percent or afterBytes`);
      }
      if (hasPercent) {
        if (typeof raw.percent !== 'number' || !(raw.percent >= 0 && raw.percent <= 100)) {
          throw new Error('percent must be a number from 0 to 100');
        }
        rule.percent = raw.percent;
      } else {
        if (!isInt(raw.afterBytes, 0)) {
          throw new Error('afterBytes must be a non-negative integer');
        }
        rule.afterBytes = raw.afterBytes;
      }
      break;
    }
    case 'wrong-content-range':
      rule.variant = raw.variant ?? 'start';
      if (rule.variant !== 'start' && rule.variant !== 'total') {
        throw new Error('variant must be "start" or "total"');
      }
      rule.whenRange = true; // only meaningful on a range request
      break;
    case 'change-etag':
      rule.ifRange = raw.ifRange ?? 'ignore';
      if (rule.ifRange !== 'ignore' && rule.ifRange !== 'honor') {
        throw new Error('ifRange must be "ignore" or "honor"');
      }
      break;
    case 'throttle':
      if (!isInt(raw.bytesPerSecond, 1)) {
        throw new Error('bytesPerSecond must be a positive integer');
      }
      rule.bytesPerSecond = raw.bytesPerSecond;
      break;
    case 'status':
      if (!isInt(raw.code, 400, 599)) {
        throw new Error('code must be an integer from 400 to 599');
      }
      rule.code = raw.code;
      if (raw.retryAfter !== undefined) {
        if (!isInt(raw.retryAfter, 0)) {
          throw new Error('retryAfter must be a non-negative integer (seconds)');
        }
        rule.retryAfter = raw.retryAfter;
      }
      break;
    case 'redirect': {
      rule.code = raw.code ?? 302;
      if (![301, 302, 303, 307, 308].includes(rule.code)) {
        throw new Error('redirect code must be 301, 302, 303, 307 or 308');
      }
      const hasLocation = raw.location !== undefined;
      if (hasLocation === (raw.altPort === true)) {
        throw new Error('redirect needs exactly one of location or altPort: true');
      }
      if (hasLocation) {
        let url;
        try {
          url = new URL(raw.location);
        } catch {
          throw new Error('location must be an absolute URL');
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new Error('location must be http or https');
        }
        rule.location = raw.location;
      } else {
        if (!hasAltPort) {
          throw new Error('altPort: true requires the server to be started with --alt-port');
        }
        rule.altPort = true;
      }
      break;
    }
    case 'oversize':
      rule.extraBytes = raw.extraBytes ?? 1024 * 1024;
      if (!isInt(rule.extraBytes, 1)) {
        throw new Error('extraBytes must be a positive integer');
      }
      rule.declareLength = raw.declareLength ?? false;
      if (typeof rule.declareLength !== 'boolean') {
        throw new Error('declareLength must be a boolean');
      }
      break;
    case 'endless':
      if (raw.maxBytes !== undefined && raw.maxBytes !== null) {
        if (!isInt(raw.maxBytes, 1)) {
          throw new Error('maxBytes must be a positive integer (omit for no cap)');
        }
        rule.maxBytes = raw.maxBytes;
      }
      break;
    default: // ignore-range, status-416, gzip take no parameters
      break;
  }
  return rule;
}

class FaultPlan {
  constructor() {
    this.entries = [];
  }

  set(rawRules, options) {
    if (!Array.isArray(rawRules)) {
      throw new Error('"rules" must be an array');
    }
    const entries = rawRules.map((raw, index) => {
      try {
        const rule = normalizeRule(raw, options);
        return {rule, pattern: patternToRegExp(rule.match), remaining: rule.times ?? null, hits: 0};
      } catch (e) {
        throw new Error(`rule ${index}: ${e.message}`);
      }
    });
    this.entries = entries;
  }

  describe() {
    return this.entries.map(e => ({...e.rule, remaining: e.remaining, hits: e.hits}));
  }

  /** First live rule matching this request; consumes one use of it. */
  pick(method, pathname, hasRange) {
    for (const entry of this.entries) {
      const {rule} = entry;
      if (entry.remaining === 0 || !rule.methods.includes(method) ||
          !entry.pattern.test(pathname) ||
          (rule.whenRange !== undefined && rule.whenRange !== hasRange)) {
        continue;
      }
      if (entry.remaining !== null) {
        entry.remaining -= 1;
      }
      entry.hits += 1;
      return rule;
    }
    return null;
  }
}

// --------------------------------------------------------------------------
// Static file helpers
// --------------------------------------------------------------------------

function contentTypeFor(file) {
  return file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
}

// Mirrors the production object metadata (DST-002, DST-003) so the same
// validation tool passes against this server and against CloudFront.
function cacheControlFor(pathname) {
  if (pathname.startsWith('/models/')) {
    return 'public,max-age=31536000,immutable';
  }
  if (pathname.startsWith('/releases/')) {
    return 'public,max-age=300';
  }
  return 'no-store';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --------------------------------------------------------------------------
// Server
// --------------------------------------------------------------------------

export function createFaultServer({root = DEFAULT_ROOT, log = line => console.log(line)} = {}) {
  const rootDir = path.resolve(root);
  const plan = new FaultPlan();
  const requests = [];
  const etagCache = new Map();
  const sockets = new Set();
  let etagGeneration = 0;
  let altPort = null;
  let realRootPromise = null;

  function realRoot() {
    realRootPromise ??= fs.promises.realpath(rootDir);
    return realRootPromise;
  }

  /** Maps a raw request path to a regular file inside the root, or null. */
  async function resolveFile(rawPathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(rawPathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('\\') ||
        decoded.split('/').some(segment => segment === '..')) {
      return null;
    }
    try {
      const base = await realRoot();
      const real = await fs.promises.realpath(path.join(base, decoded));
      if (!real.startsWith(base + path.sep)) {
        return null; // symlink escaping the root
      }
      const stat = await fs.promises.stat(real);
      return stat.isFile() ? {file: real, stat} : null;
    } catch {
      return null;
    }
  }

  /** Strong ETag: the quoted SHA-256 of the file, cached by size and mtime. */
  function etagFor(file, stat) {
    const cached = etagCache.get(file);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.promise;
    }
    const promise = new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      fs.createReadStream(file, {highWaterMark: 8 * 1024 * 1024})
        .on('data', chunk => hash.update(chunk))
        .on('error', reject)
        .on('end', () => resolve(`"${hash.digest('hex')}"`));
    });
    etagCache.set(file, {size: stat.size, mtimeMs: stat.mtimeMs, promise});
    promise.catch(() => etagCache.delete(file));
    return promise;
  }

  function sendSimple(res, status, headers, text) {
    const body = Buffer.from(text, 'utf8');
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(res.req.method === 'HEAD' ? undefined : body);
    return res.req.method === 'HEAD' ? 0 : body.length;
  }

  function sendJson(res, status, value) {
    const body = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  async function handleControl(req, res) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendJson(res, 403, {error: 'the fault control endpoint is only available from localhost'});
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, {rules: plan.describe(), requests});
      return;
    }
    if (req.method === 'DELETE') {
      plan.set([]);
      requests.length = 0;
      sendJson(res, 200, {rules: []});
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST, DELETE');
      sendJson(res, 405, {error: 'method not allowed'});
      return;
    }
    // Requiring a JSON content type keeps a web page from driving this
    // endpoint with a "simple" cross-origin form post.
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      sendJson(res, 415, {error: 'Content-Type must be application/json'});
      return;
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_CONTROL_BODY) {
        sendJson(res, 413, {error: 'rule document too large'});
        return;
      }
      chunks.push(chunk);
    }
    try {
      const doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error('body must be {"rules": [...]}');
      }
      plan.set(doc.rules, {hasAltPort: altPort !== null});
      log(`fault rules replaced: ${plan.describe().length} active`);
      sendJson(res, 200, {rules: plan.describe()});
    } catch (e) {
      sendJson(res, 400, {error: e.message});
    }
  }

  /**
   * Streams file bytes [start, end] and then applies the body fault, if any.
   * Returns the number of body bytes handed to the socket.
   */
  async function streamBody(res, file, start, end, fault) {
    const length = end - start + 1;
    let limit = length;
    if (fault && (fault.fault === 'drop' || fault.fault === 'truncate')) {
      limit = fault.afterBytes !== undefined
        ? Math.min(length, fault.afterBytes)
        : Math.floor((length * fault.percent) / 100);
    }
    const throttle = fault?.fault === 'throttle' ? fault.bytesPerSecond : null;
    let sent = 0;
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    res.on('error', () => {
      closed = true;
    });

    // Each write waits for its flush callback: simple backpressure, and the
    // byte count is exact when a fault cuts the response short.
    const flush = piece => new Promise(resolve => {
      if (closed) {
        resolve();
        return;
      }
      const done = () => {
        res.off('close', done);
        resolve();
      };
      res.once('close', done);
      res.write(piece, done);
    });
    const write = async chunk => {
      if (throttle === null) {
        await flush(chunk);
        sent += chunk.length;
        return;
      }
      // Ten slices per second keep the rate smooth without a busy loop.
      const slice = Math.max(1, Math.floor(throttle / 10));
      for (let o = 0; o < chunk.length && !closed; o += slice) {
        const piece = chunk.subarray(o, Math.min(chunk.length, o + slice));
        await flush(piece);
        sent += piece.length;
        await sleep((piece.length / throttle) * 1000);
      }
    };

    if (limit > 0) {
      const stream = fs.createReadStream(file, {start, end: start + limit - 1, highWaterMark: READ_CHUNK});
      try {
        for await (const chunk of stream) {
          if (closed) {
            break;
          }
          await write(chunk);
        }
      } finally {
        stream.destroy();
      }
    }

    if (fault?.fault === 'oversize' || fault?.fault === 'endless') {
      let extra = fault.fault === 'oversize' ? fault.extraBytes : (fault.maxBytes ?? Infinity);
      while (extra > 0 && !closed) {
        const piece = extra >= FILLER.length ? FILLER : FILLER.subarray(0, extra);
        await write(piece);
        extra -= piece.length;
      }
    }

    if (closed) {
      return sent;
    }
    if (fault?.fault === 'drop') {
      // Abrupt loss of connectivity: reset instead of a clean FIN. The short
      // pause lets the flushed bytes reach the client before the reset.
      await sleep(25);
      res.socket?.resetAndDestroy();
      return sent;
    }
    res.end();
    return sent;
  }

  async function handleFile(req, res, pathname, entry) {
    const method = req.method;
    const rangeHeader = method === 'GET' ? req.headers.range : undefined;
    const fault = plan.pick(method, pathname, rangeHeader !== undefined);
    entry.fault = fault ? fault.fault : null;

    if (fault?.fault === 'status') {
      const headers = fault.retryAfter === undefined ? {} : {'Retry-After': String(fault.retryAfter)};
      entry.bytes = sendSimple(res, fault.code, headers, `injected status ${fault.code}\n`);
      return;
    }
    if (fault?.fault === 'redirect') {
      const host = (req.headers.host ?? 'localhost').replace(/:\d+$/, '');
      const location = fault.altPort ? `http://${host}:${altPort}${pathname}` : fault.location;
      entry.bytes = sendSimple(res, fault.code, {Location: location}, 'injected redirect\n');
      return;
    }

    const resolved = await resolveFile(pathname);
    if (!resolved) {
      entry.bytes = sendSimple(res, 404, {}, 'not found\n');
      return;
    }
    const {file, stat} = resolved;
    const size = stat.size;
    let etag = await etagFor(file, stat);
    if (fault?.fault === 'change-etag') {
      etagGeneration += 1;
      etag = `"${etag.slice(1, -1)}-changed-${etagGeneration}"`;
    }
    const base = {
      'Content-Type': contentTypeFor(file),
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControlFor(pathname),
      ETag: etag,
    };

    if (fault?.fault === 'status-416') {
      entry.bytes = sendSimple(res, 416, {'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes'},
        'injected 416\n');
      return;
    }

    if (fault?.fault === 'gzip') {
      // A transforming intermediary: compressed, chunked, Range ignored.
      res.writeHead(200, {...base, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding'});
      if (method === 'HEAD') {
        res.end();
        return;
      }
      const gzip = zlib.createGzip();
      gzip.on('data', chunk => {
        entry.bytes += chunk.length;
      });
      const source = fs.createReadStream(file, {highWaterMark: READ_CHUNK});
      res.on('close', () => source.destroy());
      source.pipe(gzip).pipe(res);
      await new Promise(resolve => res.on('close', resolve));
      return;
    }

    let range = {kind: 'none'};
    if (rangeHeader !== undefined && fault?.fault !== 'ignore-range') {
      const honourIfRange = !(fault?.fault === 'change-etag' && fault.ifRange === 'ignore');
      if (!honourIfRange || ifRangeMatches(req.headers['if-range'], etag)) {
        range = parseRange(rangeHeader, size);
      }
    }
    if (range.kind === 'unsatisfiable') {
      entry.bytes = sendSimple(res, 416, {'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes'},
        'range not satisfiable\n');
      return;
    }

    const partial = range.kind === 'range';
    const start = partial ? range.start : 0;
    const end = partial ? range.end : size - 1;
    const length = end - start + 1;
    const headers = {...base};
    if (partial) {
      let claimedStart = start;
      let claimedTotal = size;
      if (fault?.fault === 'wrong-content-range') {
        if (fault.variant === 'start') {
          claimedStart = start + 1;
        } else {
          claimedTotal = size + 1;
        }
      }
      headers['Content-Range'] = `bytes ${claimedStart}-${end}/${claimedTotal}`;
    }
    const chunked = fault?.fault === 'endless' || (fault?.fault === 'oversize' && !fault.declareLength);
    if (!chunked) {
      headers['Content-Length'] = length;
    }
    if (fault && ['drop', 'truncate', 'oversize', 'endless'].includes(fault.fault)) {
      headers.Connection = 'close';
    }
    res.writeHead(partial ? 206 : 200, headers);
    if (method === 'HEAD' || length === 0) {
      res.end();
      return;
    }
    entry.bytes = await streamBody(res, file, start, end, fault);
  }

  async function handle(req, res) {
    // The query string is dropped here and never logged or interpreted.
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === CONTROL_PATH) {
      await handleControl(req, res);
      return;
    }
    const entry = {
      method: req.method,
      path: pathname,
      range: req.headers.range ?? null,
      ifRange: req.headers['if-range'] ?? null,
      status: 0,
      bytes: 0,
      fault: null,
    };
    res.on('close', () => {
      entry.status = res.statusCode;
      requests.push(entry);
      if (requests.length > MAX_LOG_ENTRIES) {
        requests.shift();
      }
      log(`${entry.method} ${entry.path} range=${entry.range ?? '-'} if-range=${entry.ifRange ?? '-'} ` +
        `status=${entry.status} bytes=${entry.bytes} fault=${entry.fault ?? '-'}`);
    });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      entry.bytes = sendSimple(res, 405, {Allow: 'GET, HEAD'}, 'method not allowed\n');
      return;
    }
    await handleFile(req, res, pathname, entry);
  }

  function makeServer() {
    const server = http.createServer((req, res) => {
      res.on('error', () => {});
      handle(req, res).catch(error => {
        log(`internal error: ${error.message}`);
        if (res.headersSent) {
          res.destroy();
        } else {
          sendSimple(res, 500, {}, 'internal error\n');
        }
      });
    });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    return server;
  }

  const servers = [];

  function listenOne(port, host) {
    const server = makeServer();
    servers.push(server);
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server.address().port));
    });
  }

  return {
    root: rootDir,
    requests,
    setRules: rules => plan.set(rules, {hasAltPort: altPort !== null}),
    getRules: () => plan.describe(),
    clearRequests: () => {
      requests.length = 0;
    },
    /** Starts the main listener and, optionally, a second "other origin" listener. */
    async listen({port = 0, host = '127.0.0.1', altPort: requestedAltPort = null} = {}) {
      const mainPort = await listenOne(port, host);
      if (requestedAltPort !== null) {
        altPort = await listenOne(requestedAltPort, host);
      }
      return {port: mainPort, altPort};
    },
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
      servers.length = 0;
    },
  };
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

async function main() {
  const {values: args} = parseArgs({
    options: {
      root: {type: 'string', default: DEFAULT_ROOT},
      port: {type: 'string', default: '8787'},
      host: {type: 'string', default: '127.0.0.1'},
      'alt-port': {type: 'string'},
      fault: {type: 'string', multiple: true},
      'faults-file': {type: 'string'},
      help: {type: 'boolean', default: false},
    },
  });
  if (args.help) {
    console.log('usage: node tools/fault-server/server.mjs [--root DIR] [--port 8787] ' +
      '[--host 127.0.0.1] [--alt-port N] [--fault JSON]... [--faults-file FILE]\n' +
      'See tools/fault-server/README.md for fault rules.');
    return;
  }
  if (!fs.existsSync(args.root) || !fs.statSync(args.root).isDirectory()) {
    throw new Error(`root directory not found: ${args.root}\n` +
      'Create it with: node model-release/dev/make-dev-bundle.mjs --model <file.gguf>');
  }
  const rules = [];
  if (args['faults-file']) {
    const doc = JSON.parse(fs.readFileSync(args['faults-file'], 'utf8'));
    rules.push(...(Array.isArray(doc) ? doc : doc.rules ?? []));
  }
  for (const text of args.fault ?? []) {
    rules.push(JSON.parse(text));
  }
  const server = createFaultServer({root: args.root});
  const bound = await server.listen({
    port: Number(args.port),
    host: args.host,
    altPort: args['alt-port'] === undefined ? null : Number(args['alt-port']),
  });
  server.setRules(rules);
  console.log(`fault server: http://${args.host}:${bound.port}  root=${server.root}`);
  if (bound.altPort !== null) {
    console.log(`other-origin listener: http://${args.host}:${bound.altPort}`);
  }
  console.log(`fault rules: ${rules.length}; control endpoint ${CONTROL_PATH} (localhost only)`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close().then(() => process.exit(0)));
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
