variable "environment" {
  description = "Deployment environment. Staging and production never share resources or state."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be \"staging\" or \"production\"."
  }
}

variable "name_prefix" {
  description = "Short lowercase prefix for resource names, chosen by the account owner. Bucket names get a random suffix from AWS (bucket_prefix); final names are read from outputs, never written in source (DST-001)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,14}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix must be 3-16 characters: lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "artifact_bucket_name" {
  description = "Optional exact name for the artifact bucket. Leave null to let AWS generate a unique name from name_prefix."
  type        = string
  default     = null
}

variable "log_bucket_name" {
  description = "Optional exact name for the access-log bucket. Leave null to let AWS generate a unique name from name_prefix."
  type        = string
  default     = null
}

variable "price_class" {
  description = "CloudFront price class. PriceClass_All includes the African edge locations; cheaper classes serve those users from farther away."
  type        = string
  default     = "PriceClass_All"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be PriceClass_100, PriceClass_200 or PriceClass_All."
  }
}

variable "aliases" {
  description = "Optional custom domain names for the distribution. Requires acm_certificate_arn. Empty means the assigned cloudfront.net domain is MODEL_ORIGIN."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "Optional ACM certificate (us-east-1) for the custom domain names. Only with a custom certificate can CloudFront enforce the TLSv1.2_2021 security policy; see infra/README.md."
  type        = string
  default     = null
}

variable "publisher_principal_arns" {
  description = "IAM principals (users or roles of the release operators or the protected release environment) allowed to assume the publisher role."
  type        = list(string)

  validation {
    condition     = length(var.publisher_principal_arns) > 0 && alltrue([for arn in var.publisher_principal_arns : can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:(user|role)/.+$", arn))])
    error_message = "publisher_principal_arns must list at least one IAM user or role ARN; wildcards and account roots are not accepted."
  }
}

variable "log_reader_principal_arns" {
  description = "IAM principals allowed to read access logs. When non-empty, every other principal is explicitly denied s3:GetObject on the log bucket (DST-005). When empty, only identities that IAM already allows can read."
  type        = list(string)
  default     = []
}

variable "alert_email" {
  description = "Address that receives alarm and budget notifications. The recipient must confirm the SNS subscription e-mail."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be an e-mail address."
  }
}

variable "alarm_5xx_rate_percent" {
  description = "Alarm when the CloudFront 5xxErrorRate (percent of all viewer requests) stays above this value."
  type        = number
  default     = 5
}

variable "alarm_bytes_downloaded_per_day" {
  description = "Alarm when CloudFront BytesDownloaded in one day exceeds this many bytes (transfer-spend proxy, DST-005). Derive it from planned installs per day times the artifact size plus retry margin."
  type        = number

  validation {
    condition     = var.alarm_bytes_downloaded_per_day > 0
    error_message = "alarm_bytes_downloaded_per_day must be positive."
  }
}

variable "create_budget" {
  description = "Create the AWS Budgets budget. Set false in one environment when staging and production share an AWS account and one budget is enough."
  type        = bool
  default     = true
}

variable "monthly_budget_limit_usd" {
  description = "Monthly cost budget in USD for the services in budget_services. Set from measured regional delivery pricing before promotion (DST-005)."
  type        = number

  validation {
    condition     = var.monthly_budget_limit_usd > 0
    error_message = "monthly_budget_limit_usd must be positive."
  }
}

variable "budget_services" {
  description = "Cost Explorer service names covered by the budget. Verify the exact spelling in the Billing console of the target account; an empty list budgets the whole account."
  type        = list(string)
  default     = ["Amazon CloudFront", "Amazon Simple Storage Service"]
}

variable "tags" {
  description = "Extra tags for every taggable resource."
  type        = map(string)
  default     = {}
}
