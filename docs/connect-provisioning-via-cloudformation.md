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
aws cloudformation deploy \
  --template-file infrastructure/cloudformation/connect-instance.template.json \
  --stack-name infinize-ucc-connect \
  --region us-east-1
```

The instance alias must be globally unique across all AWS accounts. It defaults to
`infinize-ucc-poc`; override with the `CONNECT_INSTANCE_ALIAS` environment variable in CDK,
or edit `InstanceAlias` in the template.

## What we are actually testing

Creating the instance requires the Amazon Connect **service-linked role**
(`AWSServiceRoleForAmazonConnect`). Confirmed absent — an IAM role search for "Connect"
in `279078306711` returns zero matches.

Our developer principal cannot create it: SCP `p-qocf1ngi` explicitly denies
`iam:CreateServiceLinkedRole`, and adding `iam:CreateRole` to the permission set did not
help, because an SCP deny cannot be granted around.

**The open question is whether the CloudFormation execution role is exempt from that SCP.**
Deploying this stack answers it either way:

| Outcome | Meaning | Next step |
|---|---|---|
| **Stack succeeds** | The CFN execution role is exempt. | Nothing further — take the outputs and carry on |
| **Fails on `p-qocf1ngi` / `iam:CreateServiceLinkedRole`** | The SCP denies every principal, CloudFormation included | Only an Organizations administrator can move it — see [`scp-change-request.md`](./scp-change-request.md) |
| **Fails on a different SCP or condition** | A different rule applies to the execution role | Send us the exact error; we will narrow the request |

Please capture the **exact** CloudFormation failure text, including the policy id. The
distinction between an SCP deny and a missing identity-based permission determines whether
this needs an org-level change or a routine grant, and the two error messages differ only
in a short clause:

- `with an explicit deny in a service control policy: <policy-id>` → SCP
- `because no identity-based policy allows the ... action` → permission, grantable

## Note on the CDK bootstrap role

Deploying the sibling data-plane stack (`InfinizeUccPocStack`) already failed under the CDK
bootstrap execution role `cdk-hnb659fds-cfn-exec-role-279078306711-us-east-1`, denied by SCP
`p-44cydhdk` for `dynamodb:CreateTable`, `logs:CreateLogGroup` and
`secretsmanager:CreateSecret`.

So if you deploy via `npm run cdk:deploy:connect`, it runs under **that same role** and may
well be denied for the same reason — which would tell us about `p-44cydhdk`, not about
Connect. **To test the accelerator path properly, deploy the plain template under the
accelerator's own execution role.** That is the configuration we have not yet been able to
try.

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
