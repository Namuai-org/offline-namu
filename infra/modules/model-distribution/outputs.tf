output "distribution_domain_name" {
  description = "Assigned CloudFront domain name."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "model_origin" {
  description = "MODEL_ORIGIN for the app build configuration (DST-003): https:// plus the custom domain when one is configured, else the assigned CloudFront domain. No trailing slash."
  value       = "https://${length(var.aliases) > 0 ? var.aliases[0] : aws_cloudfront_distribution.this.domain_name}"
}

output "distribution_id" {
  description = "CloudFront distribution ID (for invalidating /releases/stable.json)."
  value       = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  description = "CloudFront distribution ARN."
  value       = aws_cloudfront_distribution.this.arn
}

output "artifact_bucket_name" {
  description = "Private bucket that holds models/ and releases/."
  value       = aws_s3_bucket.artifacts.id
}

output "log_bucket_name" {
  description = "Private bucket that receives CloudFront access logs (7-day retention)."
  value       = aws_s3_bucket.logs.id
}

output "publisher_role_arn" {
  description = "Role to assume for publishing. Distinct from all read paths."
  value       = aws_iam_role.publisher.arn
}

output "alerts_topic_arn" {
  description = "SNS topic (us-east-1) that receives alarm and budget notifications."
  value       = aws_sns_topic.alerts.arn
}
