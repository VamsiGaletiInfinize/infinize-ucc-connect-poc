# AWS governance constraints

Findings from attempting to provision this POC in two Infinize AWS accounts. This is the
actionable list for an AWS Organizations administrator.

**Organization:** `o-308lhphlqp` · **Management account:** `698995614981`

**Accounts tested:**

| Account | Role | Result |
|---|---|---|
| `279078306711` | `AWSINFZFullStackDevs-Dev` | Connect blocked; CloudFormation blocked; **data plane deployed directly** |
| `575838736153` | `AWSINFZFullStackDevs-Test` | Connect blocked; CloudFormation blocked; DynamoDB blocked for all principals |

The Connect denial reproduced identically in both accounts, which means it is an
**organisation-wide policy, not an account misconfiguration**.

---

## 1 — Amazon Connect cannot be created anywhere (blocking)

**SCP:** `p-qocf1ngi`

```
User: .../AWSReservedSSO_ps-AWSINFZFullStackDevs-{Dev,Test}_.../vamsi.galeti@infinize.ai
is not authorized to perform: iam:CreateServiceLinkedRole
on resource: arn:aws:iam::<account>:role/aws-service-role/connect.amazonaws.com/AWSServiceRoleForAmazonConnect
with an explicit deny in a service control policy:
arn:aws:organizations::698995614981:policy/o-308lhphlqp/service_control_policy/p-qocf1ngi
```

Amazon Connect creates `AWSServiceRoleForAmazonConnect` on the caller's behalf during
instance creation. With that denied, `create-instance` returns an id and then transitions
to `CREATION_FAILED` a few seconds later. The role does not pre-exist in either account and
cannot be created for the same reason.

**Attempts:** five instances across two accounts, all `CREATION_FAILED`, with and without
inbound/outbound flags. `iam:CreateServiceLinkedRole` was also tested directly, independent
of Connect, in both accounts — denied identically.

**Remediation — any one of:**

1. Amend SCP `p-qocf1ngi` to allow `iam:CreateServiceLinkedRole` when
   `iam:AWSServiceName` equals `connect.amazonaws.com`:

   ```json
   {
     "Effect": "Allow",
     "Action": "iam:CreateServiceLinkedRole",
     "Resource": "arn:aws:iam::*:role/aws-service-role/connect.amazonaws.com/*",
     "Condition": { "StringEquals": { "iam:AWSServiceName": "connect.amazonaws.com" } }
   }
   ```

2. Pre-create `AWSServiceRoleForAmazonConnect` from the management account or a principal
   outside the SCP's scope.
3. Provide a sandbox account outside the OU that this SCP attaches to.

**Impact until fixed:** no live telephony. Inbound audio, DTMF, real queue behaviour under
load, and call recording capture cannot be demonstrated. The POC runs on a simulated
telephony adapter behind the same provider port (ADR-0004).

---

## 2 — CloudFormation is blocked, but the resources are not

**The key insight:** SCP `p-44cydhdk` restricts the **principal**, not the resource type.
The CDK CloudFormation execution role is denied actions that the interactive developer role
is permitted to perform in the same account.

| Action | CDK exec role | Developer role (acct `279078306711`) |
|---|---|---|
| `dynamodb:CreateTable` | **Denied** (`p-44cydhdk`) | **Allowed** |
| `logs:CreateLogGroup` | **Denied** (`p-44cydhdk`) | **Allowed** |
| `s3:CreateBucket` | — | **Allowed** |
| `ssm:PutParameter` (SecureString) | — | **Allowed** |
| `secretsmanager:CreateSecret` | **Denied** (`p-44cydhdk`) | Not tested |
| `iam:CreateRole` | — | **Denied** (identity policy, not SCP) |

Because of this, the POC data plane was provisioned directly with the developer role via
[`scripts/provision-direct.sh`](../scripts/provision-direct.sh), reproducing the CDK stack's
configuration exactly. **This is a workaround, not a recommendation** — it has no drift
detection, no dependency ordering and no rollback. Restore CloudFormation once the SCP is
amended.

Note the accounts differ: in `575838736153` (Test), SCP `p-jj9834lr` denies
`dynamodb:CreateTable` to the developer role as well, so this workaround does **not** apply
there. It succeeded only in `279078306711` (Dev).

### Original diagnosis

**SCP:** `p-44cydhdk`, applied to the **CDK CloudFormation execution role**
`cdk-hnb659fds-cfn-exec-role-575838736153-us-east-1`.

Every resource type the stack needs was denied in turn:

| Action | Resource | Result |
|---|---|---|
| `secretsmanager:CreateSecret` | verification salt | **Denied** |
| `logs:CreateLogGroup` | `/ucc/poc/api` | **Denied** |
| `dynamodb:CreateTable` | UCC single table | **Denied** |

The CDK bootstrap stack itself exists (`cdk-hnb659fds-assets-575838736153-us-east-1`), so
bootstrapping was permitted at some point — but the execution role can no longer create
resources.

**Remediation:** exempt the CDK CloudFormation execution role
(`cdk-hnb659fds-cfn-exec-role-*`) from `p-44cydhdk`, or grant it an explicit allow for the
resource types this stack provisions. Without this, no CloudFormation-managed infrastructure
can be deployed — which in practice means no infrastructure-as-code discipline at all.

---

## 3 — DynamoDB table creation is denied for developers too

**SCP:** `p-jj9834lr`, applied to the developer SSO role.

```
dynamodb:CreateTable on arn:aws:dynamodb:us-east-1:575838736153:table/ucc-poc-probe
— explicit deny in SCP p-jj9834lr
```

In **that account** DynamoDB cannot be provisioned by CloudFormation or by a developer, so
the direct-provisioning workaround in section 2 does not apply there — the POC would fall
back to its in-memory store, which implements the identical tenant-partitioned key
discipline (`services/store`).

Account `279078306711` does not carry this denial, which is where the table was created.

`ssm:DeleteParameter` is denied by the same SCP, which is why the CDK stack publishes
resource names as CloudFormation outputs rather than SSM parameters — a stack-managed SSM
parameter would make the stack impossible to delete.

---

## 4 — What IS permitted

Confirmed working, and now actually deployed, in account `279078306711`:

| Capability | Status | Notes |
|---|---|---|
| **Bedrock — Converse** | **Working** | Claude Sonnet 4.5; full POC scenarios executed live |
| **Bedrock — Titan Embeddings v2** | **Working** | `retrieval: BEDROCK_EMBEDDINGS` confirmed |
| **DynamoDB (developer role)** | **Working** | Table `ucc-poc` live with GSI1 + PITR; 103 items written |
| **S3** | **Working** | Bucket `ucc-poc-artifacts-279078306711` fully hardened |
| **SSM SecureString** | **Working** | Verification salt |
| CloudWatch Logs (developer role) | Working | Denied only for the CDK execution role |
| `iam:CreateRole` | **Denied** | Identity-policy gap, not an SCP |

The AI, retrieval and persistence layers — the parts this POC exists to evaluate — are all
working against real AWS services. Only telephony and infrastructure-as-code remain blocked.

---

## Priority for the evaluation

1. **SCP `p-qocf1ngi`** — without this, the Amazon Connect half of the comparison stays
   `[Assessed]` rather than `[Demonstrated]`. Highest value by a wide margin.
2. **SCP `p-44cydhdk`** on the CDK execution role — needed for any deployed environment.
3. **SCP `p-jj9834lr`** for DynamoDB — needed only if account `575838736153` must be used;
   `279078306711` is unaffected and now hosts the deployed data plane.

Item 1 alone converts the largest unproven column in
[the comparison](./vapi-twilio-vs-connect.md) into evidence.

---

## Resources currently live

**Account `279078306711` — intentional, in use by the POC:**

- DynamoDB table `ucc-poc` (PAY_PER_REQUEST — negligible cost at POC volume)
- S3 bucket `ucc-poc-artifacts-279078306711`
- SSM SecureString `/ucc/poc/verification-salt`

Delete the first two with `aws dynamodb delete-table --table-name ucc-poc` and
`aws s3 rb s3://ucc-poc-artifacts-279078306711 --force` when the POC is retired.

**Cleanup owed — leftovers from probing:**

- Account `575838736153`: empty S3 bucket `ucc-poc-probe-575838736153`, SSM parameter
  `/ucc/poc/verification-salt`, and stack `InfinizeUccPocStack` in `ROLLBACK_COMPLETE`
- Account `279078306711`: stack `InfinizeUccPocStack` in `ROLLBACK_COMPLETE`
- Five Amazon Connect instances in `CREATION_FAILED` across both accounts — AWS garbage
  collects these; `delete-instance` returns `ResourceNotFoundException`

Note `ssm:DeleteParameter` is denied by SCP `p-jj9834lr`, so removing the salt parameters
needs an elevated principal.
