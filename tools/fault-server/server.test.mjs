// node:test suite for the fault-injection server.
//   node --test tools/fault-server/
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, {after, before, beforeEach, describe} from 'node:test';
import zlib from 'node:zlib';
import {
  CONTROL_PATH,
  createFaultServer,
  ifRangeMatches,
  isLoopbackAddress,
  normalizeRule,
  parseRange,
} from './server.mjs';

const SIZE = 200_000;
const MODEL_PATH = '/models/fixture/model.gguf';
const DESCRIPTOR_PATH = '/releases/stable.json';

let tmp;
let content;
let etag;
let server;
let port;
let altPort;
const logLines = [];

/** One request on a fresh connection; never throws on a broken response. */
function request({method = 'GET', target = MODEL_PATH, headers = {}, body = null, stopAfter = Infinity,
  usePort = null} = {}) {
  return new Promise(resolve => {
    const chunks = [];
    let received = 0;
    let settled = false;
    const finish = value => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let response = null;
    const result = extra => ({
      status: response?.statusCode ?? 0,
      headers: response?.headers ?? {},
      body: Buffer.concat(chunks),
      complete: response?.complete ?? false,
      ...extra,
    });
    const req = http.request({host: '127.0.0.1', port: usePort ?? port, method, path: target, headers,
      agent: false}, res => {
      response = res;
      res.on('data', chunk => {
        chunks.push(chunk);
        received += chunk.length;
        if (received > stopAfter) {
          req.destroy();
        }
      });
      res.on('error', () => {});
      res.on('close', () => finish(result()));
    });
    // A reset mid-body surfaces here; report what was received so far.
    req.on('error', error => setImmediate(() => finish(result({complete: false, error}))));
    req.end(body);
  });
}

function setRules(rules) {
  server.setRules(rules);
}

/** The server records a request when its response closes, just after the client sees the end. */
async function recorded(count) {
  for (let i = 0; i < 400 && server.requests.length < count; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(server.requests.length, count, 'server request log');
  return server.requests.at(-1);
}

describe('fault server', () => {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'namu-fault-server-'));
    content = crypto.randomBytes(SIZE);
    fs.mkdirSync(path.join(tmp, 'serve/models/fixture'), {recursive: true});
    fs.mkdirSync(path.join(tmp, 'serve/releases'), {recursive: true});
    fs.writeFileSync(path.join(tmp, 'serve', MODEL_PATH), content);
    fs.writeFileSync(path.join(tmp, 'serve', DESCRIPTOR_PATH), '{"key_id":"test"}\n');
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'must never be served');
    fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(tmp, 'serve/escape.txt'));
    etag = `"${crypto.createHash('sha256').update(content).digest('hex')}"`;
    server = createFaultServer({root: path.join(tmp, 'serve'), log: line => logLines.push(line)});
    ({port, altPort} = await server.listen({port: 0, altPort: 0}));
  });

  after(async () => {
    await server.close();
    fs.rmSync(tmp, {recursive: true, force: true});
  });

  beforeEach(() => {
    setRules([]);
    server.clearRequests();
    logLines.length = 0;
  });

  // ---------------------------------------------------------------- pure helpers

  test('parseRange follows RFC 9110 single-range rules', () => {
    assert.deepEqual(parseRange(undefined, 100), {kind: 'none'});
    assert.deepEqual(parseRange('bytes=0-9', 100), {kind: 'range', start: 0, end: 9});
    assert.deepEqual(parseRange('bytes=90-', 100), {kind: 'range', start: 90, end: 99});
    assert.deepEqual(parseRange('bytes=90-500', 100), {kind: 'range', start: 90, end: 99});
    assert.deepEqual(parseRange('bytes=-10', 100), {kind: 'range', start: 90, end: 99});
    assert.deepEqual(parseRange('bytes=-500', 100), {kind: 'range', start: 0, end: 99});
    assert.deepEqual(parseRange('bytes=99-99', 100), {kind: 'range', start: 99, end: 99});
    assert.deepEqual(parseRange('bytes=100-', 100), {kind: 'unsatisfiable'});
    assert.deepEqual(parseRange('bytes=-0', 100), {kind: 'unsatisfiable'});
    assert.deepEqual(parseRange('bytes=0-', 0), {kind: 'unsatisfiable'});
    // Ignored (whole representation): invalid, reversed, multi-range, other unit.
    for (const ignored of ['bytes=9-0', 'bytes=0-1,5-6', 'items=0-1', 'bytes=-', 'bytes=a-b', 'bytes 0-1']) {
      assert.deepEqual(parseRange(ignored, 100), {kind: 'none'}, ignored);
    }
  });

  test('ifRangeMatches uses strong comparison only', () => {
    assert.equal(ifRangeMatches(undefined, '"a"'), true);
    assert.equal(ifRangeMatches('"a"', '"a"'), true);
    assert.equal(ifRangeMatches('"b"', '"a"'), false);
    assert.equal(ifRangeMatches('W/"a"', '"a"'), false);
    assert.equal(ifRangeMatches('Wed, 21 Oct 2015 07:28:00 GMT', '"a"'), false);
  });

  test('only loopback peers count as localhost', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('10.0.2.2'), false);
    assert.equal(isLoopbackAddress('192.168.1.20'), false);
    assert.equal(isLoopbackAddress(undefined), false);
  });

  test('normalizeRule rejects malformed rules', () => {
    assert.throws(() => normalizeRule({fault: 'nope'}), /fault must be one of/);
    assert.throws(() => normalizeRule({fault: 'drop'}), /exactly one of percent or afterBytes/);
    assert.throws(() => normalizeRule({fault: 'drop', percent: 50, afterBytes: 1}), /exactly one/);
    assert.throws(() => normalizeRule({fault: 'drop', percent: 101}), /0 to 100/);
    assert.throws(() => normalizeRule({fault: 'status', code: 200}), /400 to 599/);
    assert.throws(() => normalizeRule({fault: 'status', code: 503, retryAfter: -1}), /retryAfter/);
    assert.throws(() => normalizeRule({fault: 'throttle'}), /bytesPerSecond/);
    assert.throws(() => normalizeRule({fault: 'redirect'}), /exactly one of location or altPort/);
    assert.throws(() => normalizeRule({fault: 'redirect', location: 'ftp://x.invalid/'}), /http or https/);
    assert.throws(() => normalizeRule({fault: 'redirect', altPort: true}), /--alt-port/);
    assert.throws(() => normalizeRule({fault: 'gzip', match: 'models'}), /match must be/);
    assert.throws(() => normalizeRule({fault: 'gzip', times: 0}), /times/);
    assert.throws(() => normalizeRule({fault: 'gzip', surprise: 1}), /unknown rule field/);
    assert.throws(() => normalizeRule({fault: 'gzip', methods: ['POST']}), /methods/);
    assert.deepEqual(normalizeRule({fault: 'drop', percent: 10, times: 1}),
      {match: '*', fault: 'drop', times: 1, methods: ['GET'], percent: 10});
  });

  // ---------------------------------------------------------------- correct origin

  test('HEAD reports exact length, strong sha256 ETag and range support, with no body', async () => {
    const r = await request({method: 'HEAD'});
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-length'], String(SIZE));
    assert.equal(r.headers['content-type'], 'application/octet-stream');
    assert.equal(r.headers['accept-ranges'], 'bytes');
    assert.equal(r.headers.etag, etag);
    assert.equal(r.headers['cache-control'], 'public,max-age=31536000,immutable');
    assert.equal(r.headers['content-encoding'], undefined);
    assert.equal(r.body.length, 0);
  });

  test('HEAD ignores Range (range handling is defined for GET only)', async () => {
    const r = await request({method: 'HEAD', headers: {Range: 'bytes=0-9'}});
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-length'], String(SIZE));
  });

  test('GET returns the byte-identical file', async () => {
    const r = await request();
    assert.equal(r.status, 200);
    assert.equal(r.complete, true);
    assert.equal(r.headers['content-length'], String(SIZE));
    assert.ok(r.body.equals(content));
  });

  test('descriptor path gets the 300 second cache policy and JSON type', async () => {
    const r = await request({target: DESCRIPTOR_PATH});
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'public,max-age=300');
    assert.equal(r.headers['content-type'], 'application/json');
  });

  test('range GETs return 206 with an exact Content-Range', async () => {
    const cases = [
      ['bytes=0-1023', 0, 1023],
      ['bytes=100000-100999', 100000, 100999],
      [`bytes=${SIZE - 1}-${SIZE - 1}`, SIZE - 1, SIZE - 1],
      [`bytes=${SIZE - 500}-`, SIZE - 500, SIZE - 1],
      ['bytes=-1', SIZE - 1, SIZE - 1],
      [`bytes=${SIZE - 10}-${SIZE + 5000}`, SIZE - 10, SIZE - 1],
    ];
    for (const [header, start, end] of cases) {
      const r = await request({headers: {Range: header}});
      assert.equal(r.status, 206, header);
      assert.equal(r.headers['content-range'], `bytes ${start}-${end}/${SIZE}`, header);
      assert.equal(r.headers['content-length'], String(end - start + 1), header);
      assert.equal(r.headers.etag, etag, header);
      assert.ok(r.body.equals(content.subarray(start, end + 1)), header);
    }
  });

  test('a range starting at or beyond EOF is 416 with the current length', async () => {
    for (const header of [`bytes=${SIZE}-`, `bytes=${SIZE + 10}-${SIZE + 20}`, 'bytes=-0']) {
      const r = await request({headers: {Range: header}});
      assert.equal(r.status, 416, header);
      assert.equal(r.headers['content-range'], `bytes */${SIZE}`, header);
    }
  });

  test('invalid or multi-range headers are ignored and the full file is served', async () => {
    for (const header of ['bytes=5-1', 'bytes=0-1,10-11', 'lines=0-5']) {
      const r = await request({headers: {Range: header}});
      assert.equal(r.status, 200, header);
      assert.equal(r.body.length, SIZE, header);
    }
  });

  test('If-Range: matching strong ETag gives 206, anything else gives the full 200', async () => {
    const resume = {Range: 'bytes=150000-'};
    const match = await request({headers: {...resume, 'If-Range': etag}});
    assert.equal(match.status, 206);
    assert.equal(match.headers['content-range'], `bytes 150000-${SIZE - 1}/${SIZE}`);
    assert.ok(match.body.equals(content.subarray(150000)));

    for (const validator of ['"0000"', `W/${etag}`, 'Wed, 21 Oct 2015 07:28:00 GMT']) {
      const r = await request({headers: {...resume, 'If-Range': validator}});
      assert.equal(r.status, 200, validator);
      assert.equal(r.headers['content-range'], undefined, validator);
      assert.ok(r.body.equals(content), validator);
    }
  });

  test('only GET and HEAD are allowed on files', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const r = await request({method});
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.allow, 'GET, HEAD', method);
    }
  });

  test('nothing outside the root is served', async () => {
    for (const target of ['/../outside.txt', '/models/%2e%2e/%2e%2e/outside.txt', '/escape.txt',
      '/models/fixture', '/missing.gguf', '/models/%00', '/%E0%A4%A']) {
      const r = await request({target});
      assert.equal(r.status, 404, target);
      assert.ok(!r.body.toString().includes('must never be served'), target);
    }
  });

  test('query strings are ignored and never logged', async () => {
    const r = await request({target: `${MODEL_PATH}?device=abc123&token=secret`, headers: {Range: 'bytes=0-9'}});
    assert.equal(r.status, 206);
    await recorded(1);
    assert.equal(logLines.length, 1);
    assert.equal(logLines[0], `GET ${MODEL_PATH} range=bytes=0-9 if-range=- status=206 bytes=10 fault=-`);
    assert.ok(!logLines[0].includes('secret'));
    assert.ok(!JSON.stringify(server.requests).includes('secret'));
  });

  // ---------------------------------------------------------------- control endpoint

  test('control endpoint sets, lists and clears rules', async () => {
    const json = {'Content-Type': 'application/json'};
    const set = await request({method: 'POST', target: CONTROL_PATH, headers: json,
      body: JSON.stringify({rules: [{match: MODEL_PATH, fault: 'status', code: 503, times: 1}]})});
    assert.equal(set.status, 200);
    assert.equal(JSON.parse(set.body).rules[0].remaining, 1);

    assert.equal((await request()).status, 503);
    assert.equal((await request()).status, 200);

    await recorded(2);
    const list = JSON.parse((await request({target: CONTROL_PATH})).body);
    assert.equal(list.rules[0].remaining, 0);
    assert.equal(list.rules[0].hits, 1);
    assert.deepEqual(list.requests.map(e => e.status), [503, 200]);

    const cleared = await request({method: 'DELETE', target: CONTROL_PATH});
    assert.deepEqual(JSON.parse(cleared.body), {rules: []});
  });

  test('control endpoint rejects bad input', async () => {
    const json = {'Content-Type': 'application/json'};
    const noType = await request({method: 'POST', target: CONTROL_PATH, body: '{"rules":[]}'});
    assert.equal(noType.status, 415);
    const badJson = await request({method: 'POST', target: CONTROL_PATH, headers: json, body: '{'});
    assert.equal(badJson.status, 400);
    const badRule = await request({method: 'POST', target: CONTROL_PATH, headers: json,
      body: JSON.stringify({rules: [{fault: 'drop'}]})});
    assert.equal(badRule.status, 400);
    assert.match(JSON.parse(badRule.body).error, /rule 0: drop needs exactly one/);
    const tooBig = await request({method: 'POST', target: CONTROL_PATH, headers: json,
      body: JSON.stringify({rules: [], padding: 'x'.repeat(70_000)})});
    assert.equal(tooBig.status, 413);
    const put = await request({method: 'PUT', target: CONTROL_PATH});
    assert.equal(put.status, 405);
  });

  test('rules match by path pattern, Range presence and remaining count', async () => {
    setRules([
      {match: '/releases/*', fault: 'status', code: 500},
      {match: '/models/*', fault: 'status', code: 429, whenRange: true, times: 2},
    ]);
    assert.equal((await request({target: DESCRIPTOR_PATH})).status, 500);
    assert.equal((await request()).status, 200); // no Range: second rule does not apply
    assert.equal((await request({headers: {Range: 'bytes=0-0'}})).status, 429);
    assert.equal((await request({headers: {Range: 'bytes=0-0'}})).status, 429);
    assert.equal((await request({headers: {Range: 'bytes=0-0'}})).status, 206);
    // HEAD is unaffected unless a rule lists it.
    assert.equal((await request({method: 'HEAD', target: DESCRIPTOR_PATH})).status, 200);
  });

  // ---------------------------------------------------------------- faults

  test('T03 drop: connection is cut after N% with the full Content-Length promised', async () => {
    for (const percent of [10, 50, 99]) {
      server.clearRequests();
      setRules([{match: MODEL_PATH, fault: 'drop', percent, times: 1}]);
      const r = await request();
      const limit = Math.floor((SIZE * percent) / 100);
      assert.equal(r.status, 200, `drop ${percent}`);
      assert.equal(r.headers['content-length'], String(SIZE));
      assert.equal(r.complete, false, `drop ${percent} must not look complete`);
      assert.ok(r.body.length <= limit, `drop ${percent}: got ${r.body.length} > ${limit}`);
      assert.ok(r.body.equals(content.subarray(0, r.body.length)));
      assert.equal((await recorded(1)).bytes, limit);

      // The rule is spent: a correct resume from what was received succeeds.
      const resume = await request({headers: {Range: `bytes=${r.body.length}-`, 'If-Range': etag}});
      assert.equal(resume.status, 206);
      assert.ok(Buffer.concat([r.body, resume.body]).equals(content));
      await recorded(2);
    }
  });

  test('T03 drop also applies to a resumed (range) response', async () => {
    setRules([{match: MODEL_PATH, fault: 'drop', afterBytes: 1000, whenRange: true}]);
    const r = await request({headers: {Range: 'bytes=100000-'}});
    assert.equal(r.status, 206);
    assert.equal(r.complete, false);
    assert.ok(r.body.length <= 1000);
  });

  test('T04 ignore-range: 200 with the whole file in answer to a Range request', async () => {
    setRules([{match: MODEL_PATH, fault: 'ignore-range'}]);
    const r = await request({headers: {Range: 'bytes=150000-', 'If-Range': etag}});
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-range'], undefined);
    assert.equal(r.headers['content-length'], String(SIZE));
    assert.ok(r.body.equals(content));
  });

  test('T05 wrong-content-range: start and total variants', async () => {
    setRules([{match: MODEL_PATH, fault: 'wrong-content-range', variant: 'start', times: 1},
      {match: MODEL_PATH, fault: 'wrong-content-range', variant: 'total', times: 1}]);
    const start = await request({headers: {Range: 'bytes=1000-'}});
    assert.equal(start.status, 206);
    assert.equal(start.headers['content-range'], `bytes 1001-${SIZE - 1}/${SIZE}`);
    const total = await request({headers: {Range: 'bytes=1000-'}});
    assert.equal(total.status, 206);
    assert.equal(total.headers['content-range'], `bytes 1000-${SIZE - 1}/${SIZE + 1}`);
    // A request without Range is never touched by this fault.
    setRules([{match: MODEL_PATH, fault: 'wrong-content-range'}]);
    assert.equal((await request()).status, 200);
  });

  test('T05 change-etag: a new ETag on every response', async () => {
    setRules([{match: MODEL_PATH, fault: 'change-etag'}]);
    const first = await request({headers: {Range: 'bytes=0-9'}});
    const second = await request({headers: {Range: 'bytes=10-19', 'If-Range': etag}});
    // Default "ignore": a broken origin answers 206 although the object changed.
    assert.equal(second.status, 206);
    assert.notEqual(first.headers.etag, etag);
    assert.notEqual(second.headers.etag, first.headers.etag);
    assert.match(second.headers.etag, /^"[0-9a-f]{64}-changed-\d+"$/);

    // "honor": a correct origin whose object changed answers 200 with the new ETag.
    setRules([{match: MODEL_PATH, fault: 'change-etag', ifRange: 'honor'}]);
    const honest = await request({headers: {Range: 'bytes=10-19', 'If-Range': etag}});
    assert.equal(honest.status, 200);
    assert.notEqual(honest.headers.etag, etag);
    assert.equal(honest.body.length, SIZE);
  });

  test('T05 truncate: clean close before the promised Content-Length', async () => {
    setRules([{match: MODEL_PATH, fault: 'truncate', percent: 50}]);
    const r = await request();
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-length'], String(SIZE));
    assert.equal(r.body.length, SIZE / 2);
    assert.equal(r.complete, false);
    assert.ok(r.body.equals(content.subarray(0, SIZE / 2)));
  });

  test('T06 status-416: always 416 whatever the request', async () => {
    setRules([{match: MODEL_PATH, fault: 'status-416'}]);
    for (const headers of [{}, {Range: 'bytes=0-'}, {Range: `bytes=${SIZE}-`}]) {
      const r = await request({headers});
      assert.equal(r.status, 416);
      assert.equal(r.headers['content-range'], `bytes */${SIZE}`);
    }
  });

  test('T07 oversize: chunked body longer than the file', async () => {
    setRules([{match: MODEL_PATH, fault: 'oversize', extraBytes: 4096}]);
    const r = await request();
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-length'], undefined);
    assert.equal(r.headers['transfer-encoding'], 'chunked');
    assert.equal(r.body.length, SIZE + 4096);
    assert.ok(r.body.subarray(0, SIZE).equals(content));
  });

  test('T07 oversize with declareLength: more bytes on the wire than Content-Length', async () => {
    setRules([{match: MODEL_PATH, fault: 'oversize', extraBytes: 4096, declareLength: true}]);
    const r = await request();
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-length'], String(SIZE));
    assert.equal((await recorded(1)).bytes, SIZE + 4096);
  });

  test('T07 endless: body continues until the client gives up', async () => {
    setRules([{match: MODEL_PATH, fault: 'endless'}]);
    const r = await request({stopAfter: SIZE * 3});
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-length'], undefined);
    assert.ok(r.body.length > SIZE * 3);
    assert.equal(r.complete, false);
    // The server notices the disconnect, stops producing data and records the request.
    assert.equal((await recorded(1)).fault, 'endless');
  });

  test('endless honours an optional maxBytes cap', async () => {
    setRules([{match: MODEL_PATH, fault: 'endless', maxBytes: 1000}]);
    const r = await request();
    assert.equal(r.body.length, SIZE + 1000);
    assert.equal(r.complete, true);
  });

  test('throttle limits the transfer rate', async () => {
    setRules([{match: MODEL_PATH, fault: 'throttle', bytesPerSecond: 40_000}]);
    const started = Date.now();
    const r = await request({headers: {Range: 'bytes=0-19999'}});
    const elapsed = Date.now() - started;
    assert.equal(r.status, 206);
    assert.ok(r.body.equals(content.subarray(0, 20000)));
    assert.ok(elapsed >= 400, `20000 bytes at 40000 B/s took only ${elapsed} ms`);
  });

  test('DL-007 status: 408/429/500/503 with optional Retry-After for the next N requests', async () => {
    for (const code of [408, 429, 500, 503]) {
      setRules([{match: MODEL_PATH, fault: 'status', code, retryAfter: 7, times: 2}]);
      for (let i = 0; i < 2; i++) {
        const r = await request();
        assert.equal(r.status, code);
        assert.equal(r.headers['retry-after'], '7');
      }
      assert.equal((await request()).status, 200);
    }
    setRules([{match: MODEL_PATH, fault: 'status', code: 503, times: 1}]);
    assert.equal((await request()).headers['retry-after'], undefined);
  });

  test('redirect: 302 to another origin', async () => {
    setRules([{match: MODEL_PATH, fault: 'redirect', location: 'https://other-origin.invalid/model.gguf'}]);
    const external = await request();
    assert.equal(external.status, 302);
    assert.equal(external.headers.location, 'https://other-origin.invalid/model.gguf');

    // altPort: a second live listener, i.e. a different origin that really serves the bytes.
    setRules([{match: MODEL_PATH, fault: 'redirect', altPort: true, code: 307, times: 1}]);
    const r = await request({headers: {Host: `127.0.0.1:${port}`}});
    assert.equal(r.status, 307);
    assert.equal(r.headers.location, `http://127.0.0.1:${altPort}${MODEL_PATH}`);
    const other = await request({usePort: altPort, headers: {Range: 'bytes=0-9'}});
    assert.equal(other.status, 206);
  });

  test('gzip: Content-Encoding injection with a transformed body', async () => {
    setRules([{match: MODEL_PATH, fault: 'gzip'}]);
    const r = await request({headers: {'Accept-Encoding': 'identity', Range: 'bytes=0-9'}});
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.equal(r.headers['content-length'], undefined);
    assert.ok(zlib.gunzipSync(r.body).equals(content));
  });

  test('ETag follows the file content', async () => {
    const target = '/models/fixture/other.gguf';
    const file = path.join(tmp, 'serve', target);
    fs.writeFileSync(file, 'first version');
    const one = await request({target});
    fs.writeFileSync(file, 'second version, different length');
    const two = await request({target});
    assert.equal(one.headers.etag, `"${crypto.createHash('sha256').update('first version').digest('hex')}"`);
    assert.equal(two.headers.etag,
      `"${crypto.createHash('sha256').update('second version, different length').digest('hex')}"`);
  });
});
