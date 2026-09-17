#!/usr/bin/env node
// Publication step (d): publish releases/stable.json, and only after the
// artifact it points at has passed validate-distribution.mjs --full (DST-003).
// A rollback is the same command with a higher-sequence descriptor that points
// at an earlier known-good artifact (SIG-005, REL-006).
//
//   node model-release/publish/publish-descriptor.mjs \
//     --bucket <artifact bucket output> --origin https://<distribution domain output> \
//     --descriptor <signed envelope> --keys <release-keys.json> \
//     --lock <model.lock.json of the artifact the descriptor points at> \
//     --validation-report <report.json from validate-distribution --full> \
//     --runtime-build-id llamarn-0.12.9-b10256 --app-build <n> \
//     [--first-release]            nothing is published yet at releases/stable.json
//     [--distribution-id <id>]     also invalidate /releases/stable.json
//     [--wait-seconds 360] [--dry-run] [--dev-profile]
//
// NOT EXECUTED against AWS in the authoring environment. --dry-run performs
// every local and read-only HTTP check and prints the AWS commands.
//
// Order of operations:
//   1. local: verify the envelope with the reference verifier as an update
//      for the given app build, and require it to match the lock exactly.
//   2. local: require a passing --full validation report for this origin,
//      path and SHA-256.
//   3. HTTP:  read the currently published descriptor; the new sequence must
//      be strictly higher (identical bytes are reported as already published).
//   4. HTTP:  HEAD the artifact through the origin one more time.
//   5. AWS:   s3api put-object releases/stable.json, Cache-Control public,max-age=300.
//   6. AWS:   optional cloudfront create-invalidation for /releases/stable.json only.
//   7. HTTP:  poll the origin until it serves the new bytes, then verify them again.
import crypto from 'node:crypto';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {
  BUCKET_REGION,
  DESCRIPTOR_CACHE_CONTROL,
  DESCRIPTOR_CONTENT_TYPE,
  DESCRIPTOR_KEY,
  decodeUnverifiedPayload,
  parseOrigin,
  probe,
  readLock,
  runAws,
  sha256HexToBase64,
} from './lib.mjs';
import {loadKeys, verifyEnvelope} from './verify-descriptor.mjs';

const INVALIDATION_PATH = `/${DESCRIPTOR_KEY}`;

export function putDescriptorArgs({bucket, file, sha256Hex}) {
  return [
    's3api', 'put-object',
    '--region', BUCKET_REGION,
    '--bucket', bucket,
    '--key', DESCRIPTOR_KEY,
    '--body', file,
    '--content-type', DESCRIPTOR_CONTENT_TYPE,
    '--cache-control', DESCRIPTOR_CACHE_CONTROL,
    '--checksum-algorithm', 'SHA256',
    '--checksum-sha256', sha256HexToBase64(sha256Hex),
  ];
}

export function invalidationArgs({distributionId}) {
  return ['cloudfront', 'create-invalidation', '--distribution-id', distributionId, '--paths', INVALIDATION_PATH];
}

/** The report must be a passing --full run for exactly this origin and artifact. */
export function validationReportProblems(report, {origin, descriptor}) {
  const problems = [];
  if (report?.tool !== 'validate-distribution') {
    problems.push('not a validate-distribution report');
  }
  if (report?.ok !== true) {
    problems.push('report is not passing');
  }
  if (report?.full_download !== true) {
    problems.push('report lacks the full download check (rerun with --full)');
  }
  if (report?.origin !== origin) {
    problems.push(`report origin ${report?.origin} != ${origin}`);
  }
  if (report?.path !== descriptor.path || report?.sha256 !== descriptor.sha256 || report?.bytes !== descriptor.bytes) {
    problems.push('report path/bytes/sha256 differ from the descriptor');
  }
  return problems;
}

/**
 * @param {Buffer|null} currentEnvelope what the origin serves now, or null
 * @returns {{action: 'publish'|'already-published', currentSequence: number|null}}; throws if not monotonic
 */
export function sequenceDecision(currentEnvelope, newEnvelope, newSequence) {
  if (currentEnvelope === null) {
    return {action: 'publish', currentSequence: null};
  }
  if (Buffer.compare(currentEnvelope, newEnvelope) === 0) {
    return {action: 'already-published', currentSequence: newSequence};
  }
  const current = decodeUnverifiedPayload(currentEnvelope);
  if (!Number.isSafeInteger(current.sequence)) {
    throw new Error('the published descriptor has no readable sequence; investigate before publishing');
  }
  if (newSequence <= current.sequence) {
    throw new Error(`sequence ${newSequence} is not higher than the published sequence ${current.sequence}; ` +
      'apps reject replays and same-sequence changes (SIG-003)');
  }
  return {action: 'publish', currentSequence: current.sequence};
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const {values: a} = parseArgs({
    options: {
      bucket: {type: 'string'},
      origin: {type: 'string'},
      descriptor: {type: 'string'},
      keys: {type: 'string'},
      lock: {type: 'string'},
      'validation-report': {type: 'string'},
      'runtime-build-id': {type: 'string'},
      'app-build': {type: 'string'},
      'first-release': {type: 'boolean', default: false},
      'distribution-id': {type: 'string'},
      'wait-seconds': {type: 'string', default: '360'},
      'dry-run': {type: 'boolean', default: false},
      'dev-profile': {type: 'boolean', default: false},
    },
  });
  for (const required of ['bucket', 'origin', 'descriptor', 'keys', 'lock', 'validation-report',
    'runtime-build-id', 'app-build']) {
    if (!a[required]) {
      throw new Error(`--${required} is required`);
    }
  }
  const dryRun = a['dry-run'];
  const devProfile = a['dev-profile'];
  const origin = parseOrigin(a.origin);
  const keys = loadKeys(a.keys, {devProfile});
  const lock = readLock(a.lock, {allowFixture: devProfile});
  const envelope = fs.readFileSync(a.descriptor);
  const envelopeSha256 = crypto.createHash('sha256').update(envelope).digest('hex');
  const verifyOptions = {keys, source: 'update', runtimeBuildId: a['runtime-build-id'],
    appBuild: Number(a['app-build']), devProfile, lock};

  // 1. the descriptor itself
  const verified = verifyEnvelope(envelope, verifyOptions);
  if (!verified.ok) {
    throw new Error(`descriptor rejected (${verified.code}): ${verified.reason}`);
  }
  const d = verified.descriptor;
  console.log(`descriptor ok: sequence ${d.sequence}, ${d.artifact_version}, expires ${d.expires_at}`);
  console.log(`envelope sha256: ${envelopeSha256}`);

  // 2. evidence that the artifact is already downloadable
  const report = JSON.parse(fs.readFileSync(a['validation-report'], 'utf8'));
  const reportProblems = validationReportProblems(report, {origin, descriptor: d});
  if (reportProblems.length > 0) {
    throw new Error(`validation report not acceptable:\n  - ${reportProblems.join('\n  - ')}`);
  }
  console.log(`validation report ok (generated ${report.generated_at})`);

  // 3. monotonic sequence against what is live
  const descriptorUrl = `${origin}/${DESCRIPTOR_KEY}`;
  const live = await probe(descriptorUrl, {maxBody: 64 * 1024});
  let currentEnvelope = null;
  if (live.status === 200 && !live.stoppedEarly) {
    currentEnvelope = live.body;
  } else if (live.status === 403 || live.status === 404) {
    // S3 behind OAC answers 403 for a missing key (no s3:ListBucket for CloudFront).
    if (!a['first-release']) {
      throw new Error(`${descriptorUrl} answered ${live.status}. If nothing has been published yet, ` +
        'rerun with --first-release; otherwise investigate the distribution first.');
    }
  } else {
    throw new Error(`${descriptorUrl} answered ${live.status}; cannot establish the published sequence`);
  }
  const decision = sequenceDecision(currentEnvelope, envelope, d.sequence);
  if (decision.action === 'already-published') {
    console.log('the origin already serves exactly this descriptor; nothing to do');
    return;
  }
  if (currentEnvelope !== null && a['first-release']) {
    throw new Error('--first-release given, but a different descriptor is already published');
  }
  console.log(`published sequence: ${decision.currentSequence ?? '(none)'} -> new sequence: ${d.sequence}`);

  // 4. the artifact must still be there
  const head = await probe(`${origin}/${d.path}`, {method: 'HEAD'});
  if (head.status !== 200 || head.headers['content-length'] !== String(d.bytes)) {
    throw new Error(`artifact HEAD failed: status ${head.status}, length ${head.headers['content-length']}`);
  }

  // 5-6. AWS
  const put = runAws(putDescriptorArgs({bucket: a.bucket, file: a.descriptor, sha256Hex: envelopeSha256}), {dryRun});
  if (put.ran && put.status !== 0) {
    throw new Error(`put-object failed:\n${put.stderr.trim()}`);
  }
  if (a['distribution-id']) {
    const invalidation = runAws(invalidationArgs({distributionId: a['distribution-id']}), {dryRun});
    if (invalidation.ran && invalidation.status !== 0) {
      throw new Error(`create-invalidation failed:\n${invalidation.stderr.trim()}`);
    }
  }
  if (dryRun) {
    console.log('[dry-run] nothing was published');
    return;
  }

  // 7. read back through the distribution
  const deadline = Date.now() + Number(a['wait-seconds']) * 1000;
  for (;;) {
    const served = await probe(descriptorUrl, {maxBody: 64 * 1024});
    if (served.status === 200 && Buffer.compare(served.body, envelope) === 0) {
      const again = verifyEnvelope(served.body, verifyOptions);
      if (!again.ok) {
        throw new Error(`served descriptor rejected (${again.code}): ${again.reason}`);
      }
      const cacheControl = (served.headers['cache-control'] ?? '').replace(/\s+/g, '');
      if (cacheControl !== DESCRIPTOR_CACHE_CONTROL) {
        throw new Error(`served Cache-Control is "${served.headers['cache-control']}", expected ${DESCRIPTOR_CACHE_CONTROL}`);
      }
      console.log(`published and verified through the origin: ${descriptorUrl}`);
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error('the origin still serves the previous descriptor; the edge TTL is 300 s. ' +
        'Rerun this command later: it reports "already serves exactly this descriptor" once live.');
    }
    console.log('waiting for the edge cache (TTL 300 s)...');
    await sleep(15_000);
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`publish failed: ${error.message}`);
    process.exit(1);
  });
}
