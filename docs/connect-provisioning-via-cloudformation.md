# Provisioning Amazon Connect through CloudFormation

For the Infinize platform team. This replaces the earlier request to relax an SCP for a
human principal, following the guidance that **IAM roles in this organisation should be
created by CloudFormation under an approved execution role, not manually.**

## What we need

One Amazon Connect instance, voice only, plus the queues and routing profiles the POC
routes to. No email channel, no Contact Lens, no custom TTS voices — each of those widens
the permission surface and none is needed.

## What is ready

| Artifact | Purpose |
|---|---|
| [`infrastructure/cdk/lib/connect-stack.ts`](../infrastructure/cdk/lib/connect-stack.ts) | CDK stack, if you deploy from this repo |
| [`infrastructure/cloudformation/connect-instance.template.json`](../infrastructure/cloudformation/connect-instance.template.json) | **Plain CloudFormation template** — drop straight into the accelerator pipeline, no CDK required |

The template provisions 11 resources:

- 1 × `AWS::Connect::Instance` — `CONNECT_MANAGED`, inbound + outbound calls, contact flow logs
- 1 × `AWS::Connect::HoursOfOperation` — 24/7, Asia/Kolkata
- 4 × `AWS::Connect::Queue` — Admissions, Financial Aid, Technical Support, General Enquiries
- 5 × `AWS::Connect::RoutingProfile` — matching the five demo agents

Queue and routing-profile names mirror `data/university/tenant.ts` and `data/agents/agents.ts`
exactly, because UCC resolves the department and Amazon Connect owns the queue it maps to.

## Deploy

From this repo, if the CDK execution role is permitted:

```bash
export AWS_PROFILE=<profile>
export AWS_REGION=us-east-1
npm run cdk:synth:connect     # validate
npm run cdk:deploy:connect
```

Or through the accelerator pipeline, using the plain template:

```bash
aws cloudformation deploy \n  --template-file infrastructure/cloudformation/connect-instance.template.json \n  --stack-name infinize-ucc-connect \n  --region us-east-1
```

The instance alias must be globally unique across all AWS accounts. It defaults to
`infinize-ucc-poc`; override with the `CONNECT_INSTANCE_ALIAS` environment variable in CDK,
or edit `InstanceAlias` in the template.

## TEST RESULT — CloudFormation was tried, and is also denied

**Deployed 2026-08-18 in `279078306711`, `us-east-1`.** The stack reached
`CREATE_FAILED` on `AWS::Connect::Instance` with an unhelpful message:

```
Resource handler returned message: "Creating instance failed due to internal failure,
please retry."  (HandlerErrorCode: null)
```

That message is misleading — it is not an internal AWS fault and retrying does not help.
CloudTrail shows what actually happened:

```json
{
  "userIdentity": {
    "arn": ".../cdk-hnb659fds-cfn-exec-role-279078306711-us-east-1/AWSCloudFormation",
    "invokedBy": "cloudformation.amazonaws.com"
  },
  "eventName": "CreateServiceLinkedRole",
  "errorCode": "AccessDenied",
  "errorMessage": "... is not authorized to perform: iam:CreateServiceLinkedRole on
     resource: .../AWSServiceRoleForAmazonConnect_vBelN8CkwsMn0BKwlbLN with an explicit
     deny in a service control policy:
     arn:aws:organizations::698995614981:policy/o-308lhphlqp/service_control_policy/p-qocf1ngi"
}
```

**Two things this establishes:**

1. `connect:CreateInstance` itself is **permitted** for the CloudFormation execution role —
   there was no denial on the Connect action. The stack got as far as creating the instance.
2. `iam:CreateServiceLinkedRole` is **denied by the same SCP `p-qocf1ngi`**, for a principal
   invoked by CloudFormation (`invokedBy: cloudformation.amazonaws.com`).

So going through CloudFormation does **not** in itself bypass the SCP. The policy is not
written as "humans denied, CloudFormation allowed" — it denied a CloudFormation-invoked
principal outright.

### The accelerator route — one small permission away from being testable

The test above used the **CDK bootstrap** execution role. If `p-qocf1ngi` carries a principal
exemption it would be keyed to specific role ARNs — plausibly `AWSAccelerator-*` — which the
CDK role would not match.

We do not need to assume that role to test it. **CloudFormation can assume it for us**, if
we pass it with `--role-arn`. And `AWSAccelerator-Deployment-Role` already trusts
CloudFormation to do so:

```json
{ "Effect": "Allow",
  "Principal": { "Service": "cloudformation.amazonaws.com" },
  "Action": "sts:AssumeRole" }
```

The only thing stopping us is a missing permission on our own principal — **and it is a
missing permission, not an SCP deny**:

```
is not authorized to perform: iam:PassRole
on resource: arn:aws:iam::279078306711:role/AWSAccelerator-Deployment-Role
because no identity-based policy allows the iam:PassRole action
```

### The ask — a three-line IAM policy

Add this to the `ps-AWSINFZFullStackDevs-Dev` permission set, exactly as `iam:CreateRole`
was added earlier:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PassAcceleratorRoleToCloudFormation",
    "Effect": "Allow",
    "Action": "iam:PassRole",
    "Resource": "arn:aws:iam::279078306711:role/AWSAccelerator-Deployment-Role",
    "Condition": {
      "StringEquals": { "iam:PassedToService": "cloudformation.amazonaws.com" }
    }
  }]
}
```

The condition key restricts it tightly: the role can be handed to CloudFormation and to
nothing else. It grants no ability to assume the role directly.

Then this one command settles whether the accelerator route works:

```bash
aws cloudformation create-stack \
  --stack-name infinize-ucc-connect \
  --template-body file://infrastructure/cloudformation/connect-instance.template.json \
  --role-arn arn:aws:iam::279078306711:role/AWSAccelerator-Deployment-Role \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM
```

- **Stack succeeds** → the accelerator role is exempt from `p-qocf1ngi`. Done, no policy
  change needed, and this becomes the supported way to provision Connect here.
- **Fails on `p-qocf1ngi` again** → no principal is exempt, and the SCP itself must change.
  See [`scp-change-request.md`](./scp-change-request.md).

Either way it is a definitive answer for the cost of one permission and one command.

### What we could not check ourselves

- `organizations:DescribePolicy` on `p-qocf1ngi` → `AccessDeniedException` (member accounts
  cannot read SCPs)
- `sts:AssumeRole` into `AWSAccelerator-Deployment-Role` → `AccessDenied` (and unnecessary,
  given the `PassRole` route above)

## Background — why the service-linked role matters

Creating a Connect instance requires `AWSServiceRoleForAmazonConnect`. Confirmed absent: an
IAM role search for "Connect" in `279078306711` returns zero matches.

Amazon Connect asks IAM to create that role on the caller's behalf during instance creation.
Every route we have tried is refused at that step:

| Route | Principal | Result |
|---|---|---|
| CLI `create-instance` × 5 | Developer SSO role | `CREATION_FAILED` — SCP `p-qocf1ngi` |
| Console wizard × 2 | Developer SSO role | Failed earlier, on the email channel's SES role |
| **CDK / CloudFormation** | **CDK CFN execution role** | **`CREATE_FAILED` — SCP `p-qocf1ngi`** |

Adding `iam:CreateRole` to the permission set addressed the identity-based half and changed
nothing, because an SCP deny cannot be granted around.

## After the instance exists

1. Claim a phone number in the Connect console and associate it with a contact flow
2. Build the inbound contact flow, pointing its integration at the UCC API:
   - `POST /api/calls/inbound` — `{ providerContactId, callerPhoneNumber, providerEventId }`
   - `POST /api/calls/:id/turn` — `{ utterance }`
   - `POST /api/calls/:id/end` — `{ reason, providerEventId }`
3. Enable call recording to the POC S3 bucket `ucc-poc-artifacts-279078306711`
4. Point the application at it — **no application code changes**:

```bash
export UCC_TELEPHONY=connect
export CONNECT_INSTANCE_ID=<from stack output ConnectInstanceId>
export CONNECT_CONTACT_FLOW_ID=<flow id>
export CONNECT_SOURCE_PHONE_NUMBER=<claimed E.164 number>
```

Verify with `curl -s localhost:4000/health` — `"telephonyLive": true`.

Full sequence: [`deployment.md`](./deployment.md).
