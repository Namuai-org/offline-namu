# Everything account-specific is a variable without a default. Supply the
# values in terraform.tfvars (ignored by git; see terraform.tfvars.example).

variable "aws_account_id" {
  description = "The 12-digit AWS account this environment may be applied to."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be 12 digits."
  }
}

variable "name_prefix" {
  description = "Short lowercase prefix for resource names (3-16 characters)."
  type        = string
}

variable "publisher_principal_arns" {
  description = "IAM users or roles allowed to assume the publisher role."
  type        = list(string)
}

variable "alert_email" {
  description = "Address for alarm and budget notifications (must confirm the SNS subscription)."
  type        = string
}

variable "alarm_bytes_downloaded_per_day" {
  description = "Daily BytesDownloaded alarm threshold in bytes."
  type        = number
}

variable "monthly_budget_limit_usd" {
  description = "Monthly cost budget in USD."
  type        = number
}

variable "log_reader_principal_arns" {
  description = "IAM principals allowed to read access logs; empty means IAM alone decides."
  type        = list(string)
  default     = []
}

variable "price_class" {
  description = "CloudFront price class."
  type        = string
  default     = "PriceClass_All"
}

variable "aliases" {
  description = "Optional custom domain names (requires acm_certificate_arn)."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "Optional ACM certificate ARN in us-east-1 for the custom domain names."
  type        = string
  default     = null
}

variable "alarm_5xx_rate_percent" {
  description = "5xxErrorRate alarm threshold in percent."
  type        = number
  default     = 5
}

variable "create_budget" {
  description = "Create the AWS Budgets budget in this environment."
  type        = bool
  default     = true
}

variable "budget_services" {
  description = "Cost Explorer service names covered by the budget."
  type        = list(string)
  default     = ["Amazon CloudFront", "Amazon Simple Storage Service"]
}
