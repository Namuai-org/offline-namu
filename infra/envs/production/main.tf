module "model_distribution" {
  source = "../../modules/model-distribution"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment = "production"
  name_prefix = var.name_prefix

  price_class         = var.price_class
  aliases             = var.aliases
  acm_certificate_arn = var.acm_certificate_arn

  publisher_principal_arns  = var.publisher_principal_arns
  log_reader_principal_arns = var.log_reader_principal_arns

  alert_email                    = var.alert_email
  alarm_5xx_rate_percent         = var.alarm_5xx_rate_percent
  alarm_bytes_downloaded_per_day = var.alarm_bytes_downloaded_per_day
  create_budget                  = var.create_budget
  monthly_budget_limit_usd       = var.monthly_budget_limit_usd
  budget_services                = var.budget_services
}
