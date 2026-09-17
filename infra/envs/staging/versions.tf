# Exact pins (STK-001). Change them only in a reviewed commit, then run
# `terraform init -upgrade` and commit the updated .terraform.lock.hcl.
terraform {
  required_version = "= 1.16.3"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.100.0"
    }
  }
}
