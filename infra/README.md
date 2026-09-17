# Namu model distribution infrastructure

Terraform for PRD section 6 (DST-001 … DST-005, D08, D09): a private S3 bucket
in `eu-west-1`, a CloudFront distribution that reads it through Origin Access
Control, access logging, alarms, a budget, and a publisher role that is separate
from every read path.

> **Verification status.** Terraform is not installed in the environment where
> this was written, so **`terraform fmt`, `terraform validate` and
> `terraform plan` have not been run, and nothing has been applied to any AWS
> account.** What was done instead: every `.tf` file parses with an independent
> HCL2 parser (python-hcl2); every resource argument and block name used was
> checked against the `hashicorp/aws` **v5.100.0** documentation; variables,
> locals, resources and outputs were cross-referenced; formatting was checked
> with a hand-written approximation of `terraform fmt` rules. Treat the first
> CI run of `infra/scripts/check.sh` and the first `terraform plan` in staging
> as the real validation, and review the plan line by line.

## Layout

```
infra/
  modules/model-distribution/   reusable module (all resources)
  envs/staging/                 separate root module, state and resources
  envs/production/              separate root module, state and resources
  scripts/check.sh              terraform fmt -check + validate for both envs (CI)
```

Each environment pins Terraform `= 1.16.3` and `hashicorp/aws` `= 5.100.0`
(`versions.tf`). After the first `terraform init`, commit the generated
`.terraform.lock.hcl` of each environment (STK-001), preferably created with
`terraform providers lock -platform=linux_amd64 -platform=darwin_arm64 -platform=darwin_amd64`.

## What the module creates

| Requirement | Resources |
|---|---|
| DST-001 private bucket | `aws_s3_bucket.artifacts` (S3 Standard, `eu-west-1`), versioning enabled, all four public-access-block flags, SSE-S3, `BucketOwnerEnforced`, bucket policy: deny non-TLS + allow `s3:GetObject` on `models/*` and `releases/*` to `cloudfront.amazonaws.com` only when `aws:SourceArn` is this distribution |
| DST-001/004 delivery | `aws_cloudfront_origin_access_control` (sigv4, always) and `aws_cloudfront_distribution`: `https-only`, GET + HEAD only, HTTP/2 + HTTP/3, IPv6, no default root object, no cookies/query strings/headers forwarded or in the cache key |
| DST-002 never transform | `compress = false` on every behaviour; gzip/brotli disabled in both cache policies. Range requests are handled natively by CloudFront/S3 (D09) |
| DST-003 caching | cache policy `models/*`: origin `Cache-Control` honoured up to one year; cache policy `releases/*` (also the default behaviour): hard 300 s maximum TTL |
| DST-004 separate publishing | `aws_iam_role.publisher`: `s3:PutObject`/`s3:GetObject` on `models/*` and `releases/*`, `s3:ListBucket` limited to those prefixes, `cloudfront:CreateInvalidation`/`GetInvalidation` on this distribution; assumable only by `publisher_principal_arns`. No delete permission. Nothing in the app or in CloudFront can write |
| DST-005 logs | separate private log bucket, SSE-S3, TLS-only, **7-day expiry**, optional explicit deny of log reads for everyone except `log_reader_principal_arns`; CloudFront standard logging with cookies excluded |
| DST-005 alarms | in `us-east-1` (where CloudFront metrics live): `5xxErrorRate` alarm, daily `BytesDownloaded` alarm (fast transfer-spend proxy), SNS topic + e-mail subscription; AWS Budgets monthly cost budget with 80 % actual and 100 % forecast notifications |

Not created, on purpose: CORS or any response-headers policy (the only client
is the native app), WAF, Lambda@Edge/functions, an inference or login API, a
user database, any AWS credential for the app.

Two honest limits of the IAM policy language:

* IAM cannot restrict invalidation **paths**. The role may create invalidations
  on this distribution only; the restriction to `/releases/stable.json` is
  enforced by `model-release/publish/publish-descriptor.mjs`, which never
  invalidates anything else. `models/*` keys are immutable and never need it.
* CloudFront has no `s3:ListBucket`, so a missing key is answered `403`, not
  `404`. The app treats both as a non-retryable 4xx.

### TLS policy (read this)

The PRD asks for HTTPS only, which is enforced (`viewer_protocol_policy =
"https-only"`). A *minimum TLS version* of `TLSv1.2_2021` can be enforced by
CloudFront **only with a custom certificate**: with the default
`*.cloudfront.net` certificate AWS fixes the security policy at `TLSv1`, and the
provider documentation requires `minimum_protocol_version = "TLSv1"` in that
case. The module therefore sets:

* no `acm_certificate_arn` (default): assigned `cloudfront.net` domain, policy
  `TLSv1` as imposed by AWS. Clients still negotiate TLS 1.2/1.3, and both app
  platforms refuse anything older (iOS ATS; Android 10+ platform defaults), so
  the effective floor is TLS 1.2 on the client side;
* `aliases` + `acm_certificate_arn` (certificate in `us-east-1`):
  `sni-only`, `TLSv1.2_2021` enforced at the edge, and `model_origin` becomes
  `https://<first alias>`.

Whether to register a domain for this is an owner decision (open question in
the hand-off report). No domain is invented here.

## Names come from outputs, not from source (DST-001)

Nothing in this repository names a bucket, a domain, an account, an ARN or an
e-mail address. Buckets use `bucket_prefix`, so AWS appends a unique suffix.
After `terraform apply`, read the real values:

```bash
terraform -chdir=infra/envs/staging output
# model_origin            -> MODEL_ORIGIN in the app build configuration (DST-003)
# artifact_bucket_name    -> --bucket for model-release/publish/*
# distribution_id         -> --distribution-id for publish-descriptor.mjs
# publisher_role_arn      -> role the release operator assumes
# log_bucket_name, alerts_topic_arn, distribution_domain_name
```

Record the production outputs in the release build record
(`docs/releases/v1/`), not in source files.

## Apply order

Per environment, staging first. Production is applied only after the whole
publication runbook (`docs/runbooks/model-publication.md`) has passed against
staging.

1. **Prerequisites (owner):** the AWS account, an existing private, versioned,
   encrypted S3 bucket for Terraform state, credentials able to create the
   resources above, written model-use authorization before any public model
   hosting (PRD-007).
2. `cd infra/envs/staging`
3. `cp backend.hcl.example backend.hcl` and fill in the state bucket, key and
   region. `cp terraform.tfvars.example terraform.tfvars` and fill in the
   account ID, name prefix, publisher principals, alert e-mail, byte alarm
   threshold and budget. Both files are ignored by git. No value has a default
   on purpose.
4. `terraform init -backend-config=backend.hcl`
5. `terraform plan -out=staging.tfplan` — review it. Expected: two buckets and
   their sub-resources, one OAC, two cache policies, one distribution, one role
   and inline policy, one SNS topic + policy + subscription, two alarms, one
   budget. No resource should be public.
6. `terraform apply staging.tfplan` (CloudFront deployment takes several
   minutes).
7. **Confirm the SNS subscription e-mail**, otherwise no alarm reaches anyone.
   Then test the path once: `aws cloudwatch set-alarm-state` on the 5xx alarm
   with state `ALARM`, from an operator account.
8. `terraform output` → hand `model_origin` to the app build configuration and
   the rest to the publication runbook.
9. Commit `.terraform.lock.hcl`.
10. Repeat for `infra/envs/production` with its own backend key (ideally its
    own account), its own `terraform.tfvars`, and `create_budget` adjusted if
    both environments share one account.

Resource creation order inside one apply is handled by Terraform; the only
manual ordering is: state bucket → apply → confirm SNS e-mail → publish
artifacts → build the app with `MODEL_ORIGIN`.

Destroying: both buckets have `force_destroy = false`; a bucket that holds
objects cannot be destroyed by accident. Versioning keeps overwritten or
deleted `releases/stable.json` versions recoverable.

## Cost note (DST-005)

The selected artifact is about 2.14 GB, so **100,000 complete installations ≈
214 TB delivered before retries** (use the exact `bytes` from
`model-release/model.lock.json` for real arithmetic). Data transfer out of
CloudFront dominates the bill; S3 storage for one 2 GB object and the requests
are negligible by comparison. Before promotion:

* price the expected monthly volume with the **measured** per-GB rate for the
  regions where the users are (CloudFront prices differ by edge region; West
  African traffic is not billed at the European rate) and set
  `monthly_budget_limit_usd` from that measurement, not from a guess;
* set `alarm_bytes_downloaded_per_day` to planned installs per day × exact
  artifact bytes × a retry margin; it fires within a day, the budget lags;
* remember that `price_class` trades cost against distance to the users:
  `PriceClass_All` includes the African edge locations;
* logs: standard logs for a few requests per install are small and expire
  after 7 days.

## Privacy note (DST-005)

Access logs contain ordinary network metadata (client IP, user agent, URL,
bytes, time). The privacy text must disclose this. URLs carry no query
strings or identifiers, cookies are neither forwarded nor logged, logs expire
after seven days, and read access should be limited with
`log_reader_principal_arns`.

## CI

`infra/scripts/check.sh` runs `terraform fmt -check -recursive -diff` and, for
each environment, `terraform init -backend=false` + `terraform validate`. It
needs no AWS credentials. The `infra` job in `.github/workflows/ci.yml` runs it
with Terraform 1.16.3.
