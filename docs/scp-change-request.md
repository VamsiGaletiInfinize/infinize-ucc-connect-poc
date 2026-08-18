# SCP change request — Amazon Connect enablement

Ready to send to whoever administers AWS Organizations for Infinize. Copy from the line
below; it is written to be actionable without reading the rest of this repository.

---

**Subject:** SCP change request — allow Amazon Connect service-linked role (blocks UCC POC)

Hello,

We are evaluating Amazon Connect + Amazon Bedrock as the foundation for the Infinize
Unified Contact Center, against our current Vapi + Twilio stack. The build is complete and
running, but we cannot create an Amazon Connect instance in any account we have access to,
which leaves the central question of the evaluation unanswered.

**What fails**

Creating an Amazon Connect instance fails immediately. Amazon Connect creates a
service-linked role on the caller's behalf during instance creation, and that call is
denied:

```
User: arn:aws:sts::<account>:assumed-role/AWSReservedSSO_ps-AWSINFZFullStackDevs-<env>_.../vamsi.galeti@infinize.ai
is not authorized to perform: iam:CreateServiceLinkedRole
on resource: arn:aws:iam::<account>:role/aws-service-role/connect.amazonaws.com/AWSServiceRoleForAmazonConnect
with an explicit deny in a service control policy:
arn:aws:organizations::698995614981:policy/o-308lhphlqp/service_control_policy/p-qocf1ngi
```

`create-instance` returns an instance id and then moves to `CREATION_FAILED` a few seconds
later. The role does not pre-exist in either account, and it cannot be created for the same
reason.

**Scope of testing**

Five CLI instance attempts across two accounts — `279078306711` (Dev) and `575838736153`
(Test) — all `CREATION_FAILED`. We also called `iam:CreateServiceLinkedRole` directly,
independently of Amazon Connect, in both accounts and received the identical denial. This
is an organisation-level policy, not an account misconfiguration, so moving to another
account inside the same OU will not help.

We additionally tried the AWS console wizard in `us-east-1`, which failed earlier in the
chain with a *different* error:

```
is not authorized to perform: iam:CreateRole
on resource: arn:aws:iam::279078306711:role/service-role/AmazonConnectEmailSESAccessRole
because no identity-based policy allows the iam:CreateRole action
```

That one is a missing permission rather than an SCP deny. It appears because the console
provisions the **email channel**, which needs an SES access role. The CLI does not — it
never attempted that role across five runs.

We then confirmed in the IAM console that `AWSServiceRoleForAmazonConnect` **does not
exist** in the account (a role search for "Connect" returns zero matches). So the console
error is not evidence that the service-linked-role problem is solved; the console simply
fails on the email role first. Both obstacles are real, and they are independent.

**What we are asking for**

The primary request is item 1 below. **We do not need the email-channel permission** — we
only need voice for this evaluation, and creating the instance via the AWS CLI rather than
the console avoids the SES role entirely. If you would rather we used the console, we would
additionally need `iam:CreateRole` on
`arn:aws:iam::279078306711:role/service-role/AmazonConnect*`, but that is avoidable and we
are not asking for it.

**Primary request — any one of these**

1. Amend SCP `p-qocf1ngi` to permit the service-linked role for Amazon Connect only:

   ```json
   {
     "Effect": "Allow",
     "Action": "iam:CreateServiceLinkedRole",
     "Resource": "arn:aws:iam::*:role/aws-service-role/connect.amazonaws.com/*",
     "Condition": { "StringEquals": { "iam:AWSServiceName": "connect.amazonaws.com" } }
   }
   ```

   This is narrowly scoped: it authorises the Amazon Connect service-linked role and nothing
   else.

2. Pre-create `AWSServiceRoleForAmazonConnect` from the management account, or any principal
   outside the SCP's scope. We then need no IAM permissions at all.

3. Give us a sandbox account outside the OU this SCP attaches to.

Option 2 is the smallest change if you would rather not modify the policy.

**Why it matters**

The POC is otherwise complete and running against live AWS services — Bedrock inference and
embeddings, DynamoDB, S3. The only unproven part is Amazon Connect itself: telephony,
queues, routing profiles, agent state and call recording. Those are precisely the
capabilities the evaluation exists to assess, so without an instance our recommendation on a
significant platform decision rests on documentation rather than evidence.

**After the change**

We will create the instance with the CLI, which needs no further permissions:

```bash
aws connect create-instance   --identity-management-type CONNECT_MANAGED   --instance-alias infinize-ucc-poc   --inbound-calls-enabled --outbound-calls-enabled
```

**Secondary request (lower priority, unrelated)**

SCP `p-44cydhdk` denies the CDK CloudFormation execution role
(`cdk-hnb659fds-cfn-exec-role-*`) permissions that our developer SSO role is granted —
`dynamodb:CreateTable`, `logs:CreateLogGroup`, `secretsmanager:CreateSecret`. The practical
effect is that no infrastructure-as-code can be deployed: we provisioned the POC data plane
by hand with the developer role instead, which works but gives up drift detection and
repeatable deployments. Exempting the CDK execution role, or granting it those actions,
would restore normal IaC practice.

Happy to walk through any of this or run whatever verification you need.

Thanks,
Vamsi

---

## Notes for whoever sends this

- Replace the signature if someone else sends it.
- Full technical detail is in [`aws-governance-constraints.md`](./aws-governance-constraints.md).
- The primary and secondary requests are deliberately separated — the first unblocks the
  evaluation, the second is engineering hygiene. If only one can be granted, take the first.
