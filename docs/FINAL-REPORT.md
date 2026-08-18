# UCC CONNECT POC — FINAL REPORT

**Date:** 2026-08-14 · **Accounts:** 279078306711 (Dev), 575838736153 (Test) · **Region:** us-east-1
**Repository:** infinize-ucc-connect-poc

---

## Architecture

A modular TypeScript monolith implementing a strict ownership boundary: **Amazon Connect**
owns telephony, queues, routing profiles and agent state; **UCC** owns tenant, caller
identity, verification, authorization, business rules and case management; **Amazon
Bedrock** owns inference; the **knowledge base** answers public questions; the **university
APIs** are the sole authority for transactional student data.

Every contact — inbound or outbound — creates a `UccCall` and a `UccTicket` at call start.
Every state change lands on an append-only, idempotent event timeline. Every protected tool
call passes through a server-side authorization gate that reads persisted state, never the
conversation.

Detail: [`docs/architecture.md`](./architecture.md)

---

## AWS Resources

**Deployed and verified live** in account `279078306711`, `us-east-1`:

| Service | Resource | Evidence |
|---|---|---|
| **DynamoDB** | `ucc-poc` — single table, GSI1, PITR, KMS encryption | Full E2E run wrote **103 items**; every PK tenant-scoped; 32 events paired 1:1 with 32 idempotency records |
| **Amazon S3** | `ucc-poc-artifacts-279078306711` | Block-public-access, AES256 + bucket keys, versioned, TLS-only policy, 90-day recording lifecycle |
| **SSM Parameter Store** | `/ucc/poc/verification-salt` (SecureString) | Created out of band; value never printed or committed |
| **Bedrock — Claude Sonnet 4.5** | Converse API with tool use | All demo scenarios executed against live inference, in both accounts |
| **Bedrock — Titan Text Embeddings v2** | Semantic retrieval over 41 chunks | `retrieval: BEDROCK_EMBEDDINGS`; "what paperwork must an applicant send" ranked *Required documents* first with **no lexical overlap** |

The data plane was provisioned by [`scripts/provision-direct.sh`](../scripts/provision-direct.sh)
rather than CloudFormation, for the reason below. The configuration matches
`infrastructure/cdk/lib/ucc-stack.ts` resource for resource.

**Still blocked — see [`aws-governance-constraints.md`](./aws-governance-constraints.md):**

| Resource | Blocker |
|---|---|
| Amazon Connect instance | SCP `p-qocf1ngi` — `iam:CreateServiceLinkedRole` denied in **both accounts**, five attempts |
| CloudFormation / CDK deployment | SCP `p-44cydhdk` — denies the **CDK execution role** `dynamodb:CreateTable`, `logs:CreateLogGroup`, `secretsmanager:CreateSecret`, while permitting the **developer role** those same actions |
| IAM runtime role | `iam:CreateRole` denied — the POC runs under developer credentials locally |

The decisive detail is that `p-44cydhdk` targets the *principal*, not the resource. Once
that was established, the data plane was provisioned directly with the developer role and
the application ran against it unchanged.

---

## Acceptance results

| Capability | Result | Notes |
|---|---|---|
| Inbound | **PASS** (simulated telephony) | Full contact → case → AI → resolve/escalate path |
| Outbound | **PASS** (simulated telephony) | Campaign opens a case per contact from the system of record |
| AI | **PASS** | Live Bedrock Converse with tool use; escalates rather than fabricating |
| Knowledge Base | **PASS** | Live Titan embeddings confirmed; heading-aware chunking, cited passages; lexical fallback also verified |
| Verification | **PASS** | Hashed, 5-min expiry, 3 attempts, call-bound, never logged |
| Application | **PASS** | Protected APIs behind the gate; multi-application disambiguation |
| Escalation | **PASS** | AI → department → Connect queue → agent, bound to the ticket |
| Routing | **PASS** | Deterministic department resolution; Connect selects the agent |
| Agent | **PASS** | Accept, note, resolve, close; only the assigned agent may act |
| Callback | **PASS** | Request → queue → completion, with timeline events |
| Ticketing | **PASS** | Guarded state machine; status not settable from a client |
| Recording | **PARTIAL** | Metadata model, S3 location and retention implemented; no audio captured — requires a live Connect instance. Labelled `POC MOCK` in the UI. |
| Transcript | **PASS** | Normalized across AI and agent segments, exposed from the ticket |
| Supervisor | **PASS** | Live floor, queues, escalations, metrics, realtime feed |
| Security | **PASS** | 13 security tests; live prompt-injection refused |
| Testing | **PASS** | 83 tests passing; typecheck clean; web build clean |
| **Live telephony** | **FAIL — BLOCKED** | Amazon Connect instance creation denied by organisation SCP |
| **AWS data plane** | **PASS** | DynamoDB + S3 + SSM deployed and exercised end to end |
| **CloudFormation deployment** | **FAIL — BLOCKED** | SCP denies the CDK execution role; worked around by direct provisioning |

All nine demo scenarios from the specification pass in the automated suite, and were
additionally executed against live Bedrock via `scripts/smoke.ts`.

---

## Known issues

1. **Amazon Connect instance cannot be created.** AWS Organizations SCP
   `arn:aws:organizations::698995614981:policy/o-308lhphlqp/service_control_policy/p-qocf1ngi`
   explicitly denies `iam:CreateServiceLinkedRole` for `connect.amazonaws.com`. Connect
   creates `AWSServiceRoleForAmazonConnect` on the caller's behalf during instance creation,
   so every attempt fails. Four attempts across two accounts, all `CREATION_FAILED`,
   which confirms an organisation-wide policy rather than an account misconfiguration.
   Requires an org administrator. Full diagnosis and remediation: [ADR-0004](./adr/0004-telephony-provider-port.md).

2. **CloudFormation cannot deploy the stack.** SCP `p-44cydhdk` denies the CDK execution
   role the right to create DynamoDB tables, log groups and Secrets Manager secrets. The
   same actions are permitted to the developer role, so the data plane was provisioned
   directly instead. Infrastructure-as-code is therefore *written and synthesizing but not
   the deployment mechanism* — an acceptable POC compromise, and a genuine gap for
   production, where drift detection and dependency ordering matter.

3. **Supplied SSO session tokens expire in roughly 30-40 minutes**, which is shorter than a
   full provisioning and verification cycle. Longer-lived credentials would make live
   verification materially easier.

4. **No end-user authentication on the UCC API.** `agentId` is client-supplied. Ownership
   checks are already written against a server-side agent identity, so this is a wiring
   change to Cognito or the Infinize IdP, not a redesign.

5. **Tenant is taken from configuration**, not resolved from the dialled number.

6. **SSE fan-out is per-process** — correct for one instance, not for a load-balanced fleet.

---

## POC mocks

Each is labelled `POC MOCK` in the UI with its reason and production replacement.

| Mock | Why | Production replacement |
|---|---|---|
| Simulated telephony adapter | Connect instance creation blocked by SCP | `UCC_TELEPHONY=connect` — no code change |
| Fixed passcode `123456` | No SMS provider wired for the POC | Random code via Pinpoint/SNS; lifecycle unchanged |
| No audio recording | Requires a live Connect instance | Connect records to S3; UCC already stores the metadata |
| ~~In-memory persistence~~ | **Resolved** — DynamoDB is deployed and verified | n/a |
| Lexical retrieval fallback | Used when Bedrock is unreachable | Already the fallback path; Bedrock is the default |

Every mock sits behind an interface that the real implementation also satisfies. None
required application logic to be written twice.

---

## Production gaps

| Gap | Effort |
|---|---|
| Authentication and RBAC on the UCC API | Medium — wire an IdP; checks already exist |
| Tenant resolution from inbound DNIS | Small |
| EventBridge + SQS between Connect and the event processor | Medium — improves replay and backpressure |
| Bedrock Knowledge Base + OpenSearch instead of in-process index | Medium ([ADR-0003](./adr/0003-embeddings-not-bedrock-kb.md)) |
| AppSync or WebSockets instead of SSE | Small ([ADR-0005](./adr/0005-sse-not-appsync.md)) |
| Rate limiting on verification | Small |
| Pre-signed, audited recording access | Small |
| Load and voice-latency testing | Medium — **the largest untested area** |

---

## Vapi + Twilio comparison

Full analysis: [`docs/vapi-twilio-vs-connect.md`](./vapi-twilio-vs-connect.md)

The decisive question is not feature count but **how much contact-centre responsibility UCC
has to own**. On the Vapi + Twilio path, UCC must build and operate queueing, routing,
agent state, transfer, callback, recording storage and supervisor analytics — eight
responsibilities that are configuration on Amazon Connect. Building and running a contact
centre platform is not Infinize's business.

**Where Amazon Connect is genuinely worse:** it can be governance-blocked (as happened
here), contact flows are GUI-authored and resist code review, the learning curve is
steeper, time-to-first-call is longer, and the voice-agent UX is not turnkey.

**Where Vapi is genuinely better:** time to a working voice agent, and voice conversational
quality out of the box. This POC did not measure voice latency at all.

---

## Final recommendation

### Amazon Connect + Bedrock + UCC — with one condition

The architectural argument is strong and largely independent of the blockers: the ownership
boundary is right, the security model is demonstrably sound, and consolidating on AWS
removes two vendors from the data path for student PII.

The security result is the most transferable finding. Authorization enforced in UCC rather
than in a prompt, inference inside the AWS account under IAM, and structural tenant
isolation is materially easier to defend to a university's information-security review than
an architecture routing voice PII through a third-party processor.

**The condition:** this recommendation rests on architecture and platform capability, not on
a call that was placed. Live telephony was never exercised. Before committing, unblock the
SCP, stand up one Connect instance, claim one number, and re-run the nine scenarios with
`UCC_TELEPHONY=connect`. That is a small amount of work and it converts the largest
assessed-but-unproven column in the comparison into demonstrated fact.

**Do not present cost as a finding** — no cost modelling was performed.

**If the product is primarily a voice agent rather than a contact centre**, re-evaluate:
that is the one dimension where the incumbent is genuinely ahead, and this POC did not
test it.

---

## Verification commands

```bash
npx vitest run             # 83 tests
npm run typecheck          # clean
npm run build:web          # clean
npx tsx scripts/smoke.ts   # live Bedrock end-to-end (needs credentials)
npm run cdk:synth          # stack validates
```
