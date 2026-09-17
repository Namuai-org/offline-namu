data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  base      = "${var.name_prefix}-${var.environment}"
  origin_id = "artifact-bucket"

  # DST-002 and DST-003: the only two public key spaces.
  models_pattern   = "models/*"
  releases_pattern = "releases/*"

  tags = merge(var.tags, {
    Project     = "namu"
    Component   = "model-distribution"
    Environment = var.environment
  })
}
