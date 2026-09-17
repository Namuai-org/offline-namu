# Operational alarms (DST-005). CloudFront publishes its metrics in us-east-1
# only, and a CloudWatch alarm can only notify an SNS topic in its own region,
# so the topic, the subscription and both alarms use the us_east_1 provider.
#
# The topic is not encrypted with the AWS-managed SNS key on purpose:
# CloudWatch alarms cannot publish to a topic that uses alias/aws/sns.

resource "aws_sns_topic" "alerts" {
  provider = aws.us_east_1

  name = "${local.base}-distribution-alerts"
  tags = local.tags
}

resource "aws_sns_topic_subscription" "alert_email" {
  provider = aws.us_east_1

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

data "aws_iam_policy_document" "alerts_topic" {
  statement {
    sid       = "AllowCloudWatchAlarmsOfThisAccount"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:cloudwatch:us-east-1:${data.aws_caller_identity.current.account_id}:alarm:*"]
    }
  }

  statement {
    sid       = "AllowBudgetsOfThisAccount"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  provider = aws.us_east_1

  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}

resource "aws_cloudwatch_metric_alarm" "error_rate_5xx" {
  provider = aws.us_east_1

  alarm_name          = "${local.base}-cloudfront-5xx-error-rate"
  alarm_description   = "CloudFront 5xxErrorRate above ${var.alarm_5xx_rate_percent}% for 2 of 3 five-minute periods (DST-005)."
  namespace           = "AWS/CloudFront"
  metric_name         = "5xxErrorRate"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alarm_5xx_rate_percent
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = local.tags

  dimensions = {
    DistributionId = aws_cloudfront_distribution.this.id
    Region         = "Global"
  }
}

resource "aws_cloudwatch_metric_alarm" "bytes_downloaded" {
  provider = aws.us_east_1

  alarm_name          = "${local.base}-cloudfront-bytes-downloaded-daily"
  alarm_description   = "CloudFront BytesDownloaded in one day above the configured bound: transfer-spend proxy (DST-005)."
  namespace           = "AWS/CloudFront"
  metric_name         = "BytesDownloaded"
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.alarm_bytes_downloaded_per_day
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  tags                = local.tags

  dimensions = {
    DistributionId = aws_cloudfront_distribution.this.id
    Region         = "Global"
  }
}

# Spend guard in money terms. AWS Budgets is a global service; the default
# provider is fine. Budget data lags by hours, which is why the byte alarm
# above exists as the fast signal.
resource "aws_budgets_budget" "monthly" {
  count = var.create_budget ? 1 : 0

  name         = "${local.base}-distribution-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "cost_filter" {
    for_each = length(var.budget_services) > 0 ? [1] : []

    content {
      name   = "Service"
      values = var.budget_services
    }
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]
  }

  depends_on = [aws_sns_topic_policy.alerts]
}
