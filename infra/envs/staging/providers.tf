# The bucket lives in eu-west-1 (DST-001). CloudFront metrics, and therefore
# the alarms and their SNS topic, live in us-east-1.
# allowed_account_ids makes an apply with the wrong credentials fail early.

provider "aws" {
  region              = "eu-west-1"
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      ManagedBy = "terraform"
      Stack     = "namu-model-distribution-staging"
    }
  }
}

provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      ManagedBy = "terraform"
      Stack     = "namu-model-distribution-staging"
    }
  }
}
