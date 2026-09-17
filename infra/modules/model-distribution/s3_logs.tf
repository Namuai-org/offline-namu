# Separate private bucket for CloudFront standard access logs, kept for seven
# days (DST-005). Standard (legacy) logging delivers through a bucket ACL
# grant to the CloudFront log-delivery account, so this bucket, unlike the
# artifact bucket, must keep ACLs enabled (BucketOwnerPreferred).

data "aws_canonical_user_id" "current" {}

data "aws_cloudfront_log_delivery_canonical_user_id" "cloudfront" {}

resource "aws_s3_bucket" "logs" {
  bucket        = var.log_bucket_name
  bucket_prefix = var.log_bucket_name == null ? "${local.base}-logs-" : null
  force_destroy = false
  tags          = local.tags
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_acl" "logs" {
  bucket = aws_s3_bucket.logs.id

  access_control_policy {
    owner {
      id = data.aws_canonical_user_id.current.id
    }

    grant {
      permission = "FULL_CONTROL"

      grantee {
        id   = data.aws_canonical_user_id.current.id
        type = "CanonicalUser"
      }
    }

    grant {
      permission = "FULL_CONTROL"

      grantee {
        id   = data.aws_cloudfront_log_delivery_canonical_user_id.cloudfront.id
        type = "CanonicalUser"
      }
    }
  }

  depends_on = [aws_s3_bucket_ownership_controls.logs]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Versioning is intentionally left off here so that expiry really deletes.
resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "expire-access-logs-after-7-days"
    status = "Enabled"

    filter {}

    expiration {
      days = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "logs_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.logs.arn,
      "${aws_s3_bucket.logs.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # Restricted staff access: when readers are named, everyone else is denied
  # reading log objects even if an IAM policy would allow it. Log delivery
  # itself only writes and is not affected.
  dynamic "statement" {
    for_each = length(var.log_reader_principal_arns) > 0 ? [1] : []

    content {
      sid       = "DenyLogReadsExceptNamedReaders"
      effect    = "Deny"
      actions   = ["s3:GetObject", "s3:GetObjectVersion"]
      resources = ["${aws_s3_bucket.logs.arn}/*"]

      principals {
        type        = "*"
        identifiers = ["*"]
      }

      condition {
        test     = "ArnNotLike"
        variable = "aws:PrincipalArn"
        values   = var.log_reader_principal_arns
      }
    }
  }
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = data.aws_iam_policy_document.logs_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.logs]
}
