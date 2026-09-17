#!/usr/bin/env node
// Publication step (b): upload the byte-identical artifact (DST-002).
//
//   node model-release/publish/upload-artifact.mjs --bucket <artifact bucket output> \
//     [--lock model-release/model.lock.json] [--artifact <file>] \
//     [--dry-run] [--allow-fixture]
//
// NOT EXECUTED in the authoring environment: requires the AWS CLI v2 and the
// publisher role from `terraform output publisher_role_arn`. Use --dry-run to
// print the exact AWS commands without running them.
//
// What it does, in order:
//   1. preflight (lock complete, size and SHA-256 match) - local only.
//   2. AWS: s3api put-object to models/aya-global-q4km/<sha256>/model.gguf with
//        Content-Type application/octet-stream, no Content-Encoding,
//        Cache-Control public,max-age=31536000,immutable,
//        x-amz-checksum-sha256 = the locked digest (S3 rejects other bytes),
//        If-None-Match: * (an immutable key is never overwritten).
//      A single PutObject is used on purpose (the artifact is below the 5 GB
//      limit): its SHA-256 checksum covers the whole object, whereas a
//      multipart upload would only store a checksum of part checksums.
//   3. AWS: s3api head-object --checksum-mode ENABLED and compare length,
//      full-object SHA-256, type, cache policy and absence of an encoding.
//      The ETag is printed for the record and never used as a digest (DST-003).
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {ARTIFACT_CACHE_CONTROL, ARTIFACT_CONTENT_TYPE, BUCKET_REGION, runAws} from './lib.mjs';
import {DEFAULT_ARTIFACT, DEFAULT_LOCK, preflight} from './preflight.mjs';

export function putObjectArgs({bucket, key, file, checksumSha256Base64}) {
  return [
    's3api', 'put-object',
    '--region', BUCKET_REGION,
    '--bucket', bucket,
    '--key', key,
    '--body', file,
    '--content-type', ARTIFACT_CONTENT_TYPE,
    '--cache-control', ARTIFACT_CACHE_CONTROL,
    '--checksum-algorithm', 'SHA256',
    '--checksum-sha256', checksumSha256Base64,
    '--if-none-match', '*',
  ];
}

export function headObjectArgs({bucket, key}) {
  return [
    's3api', 'head-object',
    '--region', BUCKET_REGION,
    '--bucket', bucket,
    '--key', key,
    '--checksum-mode', 'ENABLED',
    '--output', 'json',
  ];
}

/** Compares `aws s3api head-object` JSON with what DST-002 requires. */
export function headObjectProblems(head, {bytes, checksumSha256Base64, contentType, cacheControl}) {
  const problems = [];
  if (head.ContentLength !== bytes) {
    problems.push(`ContentLength ${head.ContentLength} != ${bytes}`);
  }
  if (head.ChecksumSHA256 !== checksumSha256Base64) {
    problems.push(`ChecksumSHA256 ${head.ChecksumSHA256 ?? '(absent)'} != ${checksumSha256Base64}`);
  }
  if (head.ChecksumType !== undefined && head.ChecksumType !== 'FULL_OBJECT') {
    problems.push(`ChecksumType ${head.ChecksumType} is not FULL_OBJECT`);
  }
  if (head.ContentType !== contentType) {
    problems.push(`ContentType ${head.ContentType} != ${contentType}`);
  }
  if ((head.CacheControl ?? '').replace(/\s+/g, '') !== cacheControl) {
    problems.push(`CacheControl ${head.CacheControl ?? '(absent)'} != ${cacheControl}`);
  }
  if (head.ContentEncoding !== undefined && head.ContentEncoding !== '') {
    problems.push(`ContentEncoding must be absent, found ${head.ContentEncoding}`);
  }
  return problems;
}

async function main() {
  const {values: args} = parseArgs({
    options: {
      bucket: {type: 'string'},
      lock: {type: 'string', default: DEFAULT_LOCK},
      artifact: {type: 'string', default: DEFAULT_ARTIFACT},
      'dry-run': {type: 'boolean', default: false},
      'allow-fixture': {type: 'boolean', default: false},
    },
  });
  if (!args.bucket) {
    throw new Error('--bucket is required (terraform output artifact_bucket_name)');
  }
  const dryRun = args['dry-run'];
  const pre = await preflight({
    lockFile: args.lock, artifactFile: args.artifact, allowFixture: args['allow-fixture'],
  });
  console.log(`preflight ok: ${pre.lock.bytes} bytes, sha256 ${pre.lock.sha256}`);
  if (pre.fixture) {
    console.error('WARNING: --allow-fixture: uploading a fixture. Staging only; never production.');
  }
  const target = {bucket: args.bucket, key: pre.key};

  const put = runAws(putObjectArgs({...target, file: pre.artifactFile,
    checksumSha256Base64: pre.checksumSha256Base64}), {dryRun});
  if (put.ran && put.status !== 0) {
    if (/PreconditionFailed|\(412\)/.test(put.stderr)) {
      console.log('object already exists at this immutable key; verifying it instead of overwriting');
    } else {
      throw new Error(`put-object failed:\n${put.stderr.trim()}`);
    }
  }

  const head = runAws(headObjectArgs(target), {dryRun});
  if (!head.ran) {
    console.log('[dry-run] nothing was uploaded or verified');
    return;
  }
  if (head.status !== 0) {
    throw new Error(`head-object failed:\n${head.stderr.trim()}`);
  }
  const metadata = JSON.parse(head.stdout);
  const problems = headObjectProblems(metadata, {
    bytes: pre.lock.bytes,
    checksumSha256Base64: pre.checksumSha256Base64,
    contentType: ARTIFACT_CONTENT_TYPE,
    cacheControl: ARTIFACT_CACHE_CONTROL,
  });
  if (problems.length > 0) {
    throw new Error(`stored object does not match the lock:\n  - ${problems.join('\n  - ')}`);
  }
  console.log(`stored object verified: s3://${args.bucket}/${pre.key}`);
  console.log(`  ETag ${metadata.ETag} (recorded only; an ETag is not a SHA-256)`);
  console.log(`  VersionId ${metadata.VersionId ?? '(none)'}`);
  console.log('next: validate-distribution.mjs --full against the CloudFront origin');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`upload failed: ${error.message}`);
    process.exit(1);
  });
}
