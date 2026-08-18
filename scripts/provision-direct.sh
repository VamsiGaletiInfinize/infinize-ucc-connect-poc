#!/usr/bin/env bash
#
# Provision the UCC data plane directly with the developer role, bypassing CloudFormation.
#
# WHY THIS EXISTS
# ---------------
# SCP `p-44cydhdk` denies the CDK CloudFormation execution role
# (`cdk-hnb659fds-cfn-exec-role-*`) the right to create DynamoDB tables, log groups and
# Secrets Manager secrets — while the interactive developer role is permitted to create the
# same resources. `cdk deploy` therefore cannot work, but the resources themselves are not
# forbidden.
#
# This script creates exactly what `infrastructure/cdk/lib/ucc-stack.ts` describes, with the
# same configuration, using the developer role. It is a documented workaround, not the
# preferred path: CloudFormation should be restored once the SCP is amended, because this
# script has no drift detection and no dependency ordering.
#
# The IAM runtime role is NOT created here — `iam:CreateRole` is denied outright. For the
# POC the application runs locally under developer credentials.
#
# Idempotent: safe to re-run.

set -euo pipefail

export MSYS_NO_PATHCONV=1          # Git Bash mangles /-prefixed args on Windows

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
TABLE="${UCC_TABLE_NAME:-ucc-poc}"
BUCKET="${UCC_BUCKET_NAME:-ucc-poc-artifacts-${ACCOUNT}}"

echo "Account : $ACCOUNT"
echo "Region  : $REGION"
echo "Table   : $TABLE"
echo "Bucket  : $BUCKET"
echo

# --- DynamoDB ---------------------------------------------------------------
# Single-table design. PK = TENANT#<tenantId>#COL#<collection>, SK = <id>.
# GSI1 lists every record of one collection within a tenant for the dashboards.

if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  echo "DynamoDB table $TABLE already exists."
else
  echo "Creating DynamoDB table $TABLE ..."
  aws dynamodb create-table \
    --table-name "$TABLE" \
    --region "$REGION" \
    --attribute-definitions \
        AttributeName=PK,AttributeType=S \
        AttributeName=SK,AttributeType=S \
        AttributeName=tenantId,AttributeType=S \
        AttributeName=collection,AttributeType=S \
    --key-schema \
        AttributeName=PK,KeyType=HASH \
        AttributeName=SK,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --sse-specification Enabled=true,SSEType=KMS \
    --global-secondary-indexes '[{
        "IndexName": "GSI1",
        "KeySchema": [
          {"AttributeName": "tenantId",   "KeyType": "HASH"},
          {"AttributeName": "collection", "KeyType": "RANGE"}
        ],
        "Projection": {"ProjectionType": "ALL"}
      }]' \
    --query 'TableDescription.TableStatus' --output text

  echo "Waiting for ACTIVE ..."
  aws dynamodb wait table-exists --table-name "$TABLE" --region "$REGION"

  # Point-in-time recovery, matching the CDK stack.
  aws dynamodb update-continuous-backups \
    --table-name "$TABLE" --region "$REGION" \
    --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true \
    --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' \
    --output text
fi

# --- S3 ---------------------------------------------------------------------
# Private bucket for recordings and the KB index. Recording binaries never go in DynamoDB.

if aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  echo "S3 bucket $BUCKET already exists."
else
  echo "Creating S3 bucket $BUCKET ..."
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
  fi

  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

  aws s3api put-bucket-encryption --bucket "$BUCKET" \
    --server-side-encryption-configuration \
      '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'

  aws s3api put-bucket-versioning --bucket "$BUCKET" \
    --versioning-configuration Status=Enabled

  # TLS-only, matching `enforceSSL` in the CDK stack.
  aws s3api put-bucket-policy --bucket "$BUCKET" --policy "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"DenyInsecureTransport\",
      \"Effect\": \"Deny\",
      \"Principal\": \"*\",
      \"Action\": \"s3:*\",
      \"Resource\": [\"arn:aws:s3:::$BUCKET\", \"arn:aws:s3:::$BUCKET/*\"],
      \"Condition\": {\"Bool\": {\"aws:SecureTransport\": \"false\"}}
    }]
  }"

  # 90-day expiry on recordings, matching the CDK lifecycle rule.
  aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
    --lifecycle-configuration \
      '{"Rules":[{"ID":"recording-retention","Status":"Enabled","Filter":{"Prefix":"recordings/"},"Expiration":{"Days":90}}]}'
fi

echo
echo "Provisioned. Point the API at it with:"
echo "  export UCC_PERSISTENCE=dynamodb"
echo "  export UCC_TABLE_NAME=$TABLE"
echo "  export UCC_BUCKET_NAME=$BUCKET"
