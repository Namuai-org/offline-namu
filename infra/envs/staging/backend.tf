# Partial backend configuration: the state bucket is account-specific and is
# never written in source. Copy backend.hcl.example to backend.hcl (ignored by
# git), fill it in, then:
#
#   terraform init -backend-config=backend.hcl
#
# CI validates without state: terraform init -backend=false
terraform {
  backend "s3" {}
}
