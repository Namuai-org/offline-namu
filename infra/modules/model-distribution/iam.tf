# Release publishing identity, separate from every read path (DST-004).
# Clients never hold AWS credentials; CloudFront reads through OAC; this role
# is the only principal that can write objects.

data "aws_iam_policy_document" "publisher_assume" {
  statement {
    sid     = "AllowNamedReleaseOperators"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = var.publisher_principal_arns
    }
  }
}

resource "aws_iam_role" "publisher" {
  name                 = "${local.base}-model-publisher"
  description          = "Publishes Namu model artifacts and release descriptors (${var.environment})"
  assume_role_policy   = data.aws_iam_policy_document.publisher_assume.json
  max_session_duration = 3600
  tags                 = local.tags
}

data "aws_iam_policy_document" "publisher" {
  statement {
    sid       = "ListPublicKeySpacesOnly"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.artifacts.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = [local.models_pattern, local.releases_pattern]
    }
  }

  statement {
    sid     = "WriteAndReadBackPublishedObjects"
    effect  = "Allow"
    actions = ["s3:PutObject", "s3:GetObject"]

    resources = [
      "${aws_s3_bucket.artifacts.arn}/${local.models_pattern}",
      "${aws_s3_bucket.artifacts.arn}/${local.releases_pattern}",
    ]
  }

  # IAM has no condition key for invalidation paths, so the policy can only
  # name the distribution. The "/releases/*" restriction is enforced by the
  # publication tool, which invalidates /releases/stable.json and nothing else
  # (model-release/publish/publish-descriptor.mjs). models/* keys are immutable
  # and never need invalidation.
  statement {
    sid       = "InvalidateReleaseDescriptor"
    effect    = "Allow"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = [aws_cloudfront_distribution.this.arn]
  }
}

resource "aws_iam_role_policy" "publisher" {
  name   = "publish-models-and-releases"
  role   = aws_iam_role.publisher.id
  policy = data.aws_iam_policy_document.publisher.json
}
