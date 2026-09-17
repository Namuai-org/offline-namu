#!/usr/bin/env bash
# Static checks for infra/ (CI job "infra"). Needs terraform on PATH and
# network access to the provider registry; needs NO AWS credentials and
# touches no state (init -backend=false).
#
#   infra/scripts/check.sh
set -euo pipefail

cd "$(dirname "$0")/.."

terraform version

echo "== terraform fmt -check -recursive"
terraform fmt -check -recursive -diff

for env in envs/staging envs/production; do
  echo "== terraform validate: ${env}"
  terraform -chdir="${env}" init -backend=false -input=false -no-color
  terraform -chdir="${env}" validate -no-color
done

echo "infra checks passed"
