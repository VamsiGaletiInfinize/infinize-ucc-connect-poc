#!/usr/bin/env bash
#
# Create the verification salt as an SSM SecureString parameter.
#
# Run once per environment, BEFORE `cdk deploy`. The CDK stack grants the runtime role
# read access to this parameter but does not create it, for two reasons:
#
#   1. CloudFormation cannot create SecureString SSM parameters at all.
#   2. This organisation denies `secretsmanager:CreateSecret` (SCP p-44cydhdk), so AWS
#      Secrets Manager — the better home for this value — is unavailable.
#
# The salt is generated locally and never printed, never committed, never logged.

set -euo pipefail

PARAM_NAME="${1:-/ucc/poc/verification-salt}"
REGION="${AWS_REGION:-us-east-1}"

# Windows Git Bash rewrites /-prefixed arguments into Windows paths.
export MSYS_NO_PATHCONV=1

if aws ssm get-parameter --name "$PARAM_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "Parameter $PARAM_NAME already exists — leaving it unchanged."
  echo "Rotating the salt invalidates in-flight verification sessions; do it deliberately."
  exit 0
fi

SALT="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

aws ssm put-parameter \
  --name "$PARAM_NAME" \
  --description "Infinize UCC — salt for hashing identity verification codes" \
  --value "$SALT" \
  --type SecureString \
  --region "$REGION" \
  --output text --query Version >/dev/null

unset SALT

echo "Created SecureString parameter: $PARAM_NAME"
echo "The value was not printed and is not stored anywhere in this repository."
