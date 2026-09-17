# CloudFront distribution in front of the private bucket (DST-001..004, D08, D09).
#
# - Origin Access Control signs every origin request (sigv4, always).
# - Viewers use HTTPS only; GET and HEAD only.
# - compress = false and no Accept-Encoding in the cache key: the model is
#   never transformed (DST-002). Range requests are served natively by
#   CloudFront and S3; nothing about them belongs in the cache key (D09).
# - No cookies, query strings or headers are forwarded or cached on, so a URL
#   can carry no user or device identifier that matters (DST-005).
# - No default root object, no CORS or other response headers policy: the only
#   client is the native app.

resource "aws_cloudfront_origin_access_control" "artifacts" {
  name                              = "${local.base}-artifacts-oac"
  description                       = "Namu ${var.environment} model distribution to private S3"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# models/*: immutable, content-addressed objects. The origin's own
# Cache-Control (one year, immutable) is honoured up to max_ttl.
resource "aws_cloudfront_cache_policy" "models" {
  name        = "${local.base}-models-immutable"
  comment     = "Immutable content-addressed model artifacts"
  min_ttl     = 0
  default_ttl = 31536000
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = false
    enable_accept_encoding_gzip   = false

    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

# releases/*: the signed descriptor. Never cached for more than 300 seconds
# whatever the object metadata says (DST-003).
resource "aws_cloudfront_cache_policy" "releases" {
  name        = "${local.base}-releases-300s"
  comment     = "Signed release descriptor, 300 second TTL"
  min_ttl     = 0
  default_ttl = 300
  max_ttl     = 300

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = false
    enable_accept_encoding_gzip   = false

    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  comment         = "Namu ${var.environment} model distribution"
  is_ipv6_enabled = true
  http_version    = "http2and3"
  price_class     = var.price_class
  aliases         = var.aliases
  tags            = local.tags

  origin {
    origin_id                = local.origin_id
    domain_name              = aws_s3_bucket.artifacts.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.artifacts.id
  }

  # Anything outside models/ and releases/ reaches S3 and is refused there
  # (the bucket policy grants CloudFront nothing else), with a short TTL.
  default_cache_behavior {
    target_origin_id       = local.origin_id
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = false
    cache_policy_id        = aws_cloudfront_cache_policy.releases.id
  }

  ordered_cache_behavior {
    path_pattern           = local.models_pattern
    target_origin_id       = local.origin_id
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = false
    cache_policy_id        = aws_cloudfront_cache_policy.models.id
  }

  ordered_cache_behavior {
    path_pattern           = local.releases_pattern
    target_origin_id       = local.origin_id
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = false
    cache_policy_id        = aws_cloudfront_cache_policy.releases.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # With the default *.cloudfront.net certificate AWS fixes the security
  # policy at "TLSv1"; TLSv1.2_2021 can only be enforced with a custom
  # certificate. See "TLS policy" in infra/README.md.
  viewer_certificate {
    cloudfront_default_certificate = var.acm_certificate_arn == null
    acm_certificate_arn            = var.acm_certificate_arn
    ssl_support_method             = var.acm_certificate_arn == null ? null : "sni-only"
    minimum_protocol_version       = var.acm_certificate_arn == null ? "TLSv1" : "TLSv1.2_2021"
  }

  logging_config {
    bucket          = aws_s3_bucket.logs.bucket_domain_name
    prefix          = "cloudfront/"
    include_cookies = false
  }

  depends_on = [aws_s3_bucket_acl.logs]

  lifecycle {
    precondition {
      condition     = (length(var.aliases) == 0) == (var.acm_certificate_arn == null)
      error_message = "aliases and acm_certificate_arn must be set together: a custom domain needs its certificate, and a certificate is pointless without a domain."
    }
  }
}
