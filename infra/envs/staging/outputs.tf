# These outputs are the source of truth for names and domains (DST-001).

output "model_origin" {
  description = "MODEL_ORIGIN for the app build configuration."
  value       = module.model_distribution.model_origin
}

output "distribution_domain_name" {
  description = "Assigned CloudFront domain name."
  value       = module.model_distribution.distribution_domain_name
}

output "distribution_id" {
  description = "CloudFront distribution ID."
  value       = module.model_distribution.distribution_id
}

output "artifact_bucket_name" {
  description = "Artifact bucket name (publish tools: --bucket)."
  value       = module.model_distribution.artifact_bucket_name
}

output "log_bucket_name" {
  description = "Access-log bucket name."
  value       = module.model_distribution.log_bucket_name
}

output "publisher_role_arn" {
  description = "Role to assume for publishing."
  value       = module.model_distribution.publisher_role_arn
}

output "alerts_topic_arn" {
  description = "SNS topic for alarms and budget notifications."
  value       = module.model_distribution.alerts_topic_arn
}
