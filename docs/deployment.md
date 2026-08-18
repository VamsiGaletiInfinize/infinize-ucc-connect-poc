# Deployment

## Prerequisites

- Node.js 20+
- An AWS account with Bedrock model access in `us-east-1`
- AWS credentials via a named CLI profile or an IAM role — **never** in a file in this repo

## Local run (no AWS required)

```bash
npm install
UCC_RETRIEVAL=lexical npm start      # API on :4000
npm run dev:web                      # UI on :5173
```

This runs with in-memory persistence, simulated telephony and deterministic lexical
retrieval. Everything except Bedrock inference works offline.

## Local run with live AWS

```bash
export AWS_PROFILE=your-profile
export AWS_REGION=us-east-1
npm start
npm run dev:web
```

The API will use Bedrock for both inference and Titan embeddings. Confirm with:

```bash
curl -s localhost:4000/health
# "retrieval":"BEDROCK_EMBEDDINGS"  ← live embeddings
# "retrieval":"LEXICAL_FALLBACK"    ← embedding call failed; check credentials
```

## AWS infrastructure

> **Deployment is currently blocked by organisation SCPs.** The stack synthesizes and has
> been restructured to work around two of the three denials, but `dynamodb:CreateTable` is
> denied to every principal available. See
> [`aws-governance-constraints.md`](./aws-governance-constraints.md).

Before deploying, create the verification salt out of band (CloudFormation cannot create
SecureString parameters, and Secrets Manager is denied by SCP `p-44cydhdk`):

```bash
bash scripts/provision-salt.sh
```

Then:

```bash
export AWS_PROFILE=your-profile
export AWS_REGION=us-east-1
npm run cdk:synth        # validate
npm run cdk:deploy
```

Provisions:

| Resource | Purpose |
|---|---|
| DynamoDB table | Single-table store, PITR, AWS-managed encryption |
| S3 bucket | Recordings and KB index; block-public-access, SSE, TLS-only, 90-day lifecycle |
| IAM role | Least-privilege runtime role — scoped Bedrock ARNs, one table, one bucket |
| SSM SecureString (out of band) | Verification salt — created by `scripts/provision-salt.sh` |

Resource names are published as CloudFormation **outputs** rather than SSM parameters,
because `ssm:DeleteParameter` is denied by SCP `p-jj9834lr` and a stack-managed parameter
would make the stack undeletable. No explicit log group is created: the CDK execution role
is denied `logs:CreateLogGroup`, and Lambda/ECS create their own on first write.

Then point the API at it:

```bash
export UCC_PERSISTENCE=dynamodb
STACK=InfinizeUccPocStack
export UCC_TABLE_NAME=$(aws cloudformation describe-stacks --stack-name $STACK   --query "Stacks[0].Outputs[?OutputKey=='UccTableName'].OutputValue" --output text)
export UCC_BUCKET_NAME=$(aws cloudformation describe-stacks --stack-name $STACK   --query "Stacks[0].Outputs[?OutputKey=='UccBucketName'].OutputValue" --output text)
npm start
```

## Amazon Connect — currently blocked

> **Instance creation is denied organisation-wide by SCP `p-qocf1ngi`.** Reproduced in two
> separate accounts (`279078306711` Dev and `575838736153` Test). See
> [ADR-0004](./adr/0004-telephony-provider-port.md) and
> [`aws-governance-constraints.md`](./aws-governance-constraints.md). Until it is lifted,
> the API runs with `UCC_TELEPHONY=simulated`.

### To unblock

An AWS Organizations administrator must do one of:

1. Amend SCP `p-qocf1ngi` to allow `iam:CreateServiceLinkedRole` where
   `iam:AWSServiceName` is `connect.amazonaws.com`;
2. Pre-create `AWSServiceRoleForAmazonConnect` from a principal not bound by the SCP; or
3. Supply an AWS account outside the OU this SCP attaches to.

Note that both accounts tried so far are subject to it, so "try another account" is only a
fix if that account sits outside the policy's scope.

### Once unblocked

```bash
# 1. Create the instance
aws connect create-instance \
  --identity-management-type CONNECT_MANAGED \
  --instance-alias infinize-ucc-poc \
  --inbound-calls-enabled --outbound-calls-enabled

# 2. Wait for ACTIVE
aws connect describe-instance --instance-id <id> --query 'Instance.InstanceStatus'

# 3. Claim a phone number, create queues matching data/university/tenant.ts:
#      queue-admissions, queue-financial-aid, queue-technical-support, queue-general
#    and routing profiles matching data/agents/agents.ts.

# 4. Enable call recording on the instance, targeting the S3 bucket.

# 5. Point the contact flow's Lambda/HTTP integration at:
#      POST /api/calls/inbound   { providerContactId, callerPhoneNumber, providerEventId }
#      POST /api/calls/:id/turn  { utterance }
#      POST /api/calls/:id/end   { reason, providerEventId }

# 6. Switch the provider — no application code changes
export UCC_TELEPHONY=connect
export CONNECT_INSTANCE_ID=<id>
export CONNECT_CONTACT_FLOW_ID=<flow-id>
export CONNECT_SOURCE_PHONE_NUMBER=<e164>
npm start
```

Verify the switch took effect:

```bash
curl -s localhost:4000/health   # "telephonyLive": true
```

Also redeploy the CDK stack with `CONNECT_INSTANCE_ID` set, so the runtime IAM role gains
Connect permissions scoped to that instance.

## Configuration reference

See [`.env.example`](../.env.example). Key switches:

| Variable | Values | Effect |
|---|---|---|
| `UCC_PERSISTENCE` | `memory` \| `dynamodb` | Storage backend |
| `UCC_TELEPHONY` | `simulated` \| `connect` | Telephony adapter |
| `UCC_RETRIEVAL` | `bedrock` \| `lexical` | Live embeddings or offline scoring |
| `BEDROCK_MODEL_ID` | inference profile id | Conversation model |

## Credential handling

- AWS credentials are never read from `.env` and never committed.
- Locally, use `AWS_PROFILE`. In deployment, use the CDK-provisioned IAM role.
- The verification salt lives in an SSM SecureString parameter, not in configuration.
  Secrets Manager would be preferable but is denied by SCP `p-44cydhdk`.
- `.gitignore` excludes `.env`, `.env.*` (except `.env.example`), `cdk.out` and credential
  file patterns.

If a credential is ever committed: stop, remove it from the repository and history, rotate
it immediately in IAM, and only then continue.
