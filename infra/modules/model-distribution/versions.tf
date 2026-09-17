# The module states what it is compatible with; each environment pins exact
# versions (infra/envs/*/versions.tf).
terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = ">= 5.80.0, < 6.0.0"
      configuration_aliases = [aws.us_east_1]
    }
  }
}
