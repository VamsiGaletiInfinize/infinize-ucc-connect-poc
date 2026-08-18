# Vapi + Twilio + UCC vs Amazon Connect + Bedrock + UCC

An evidence-based comparison, grounded in what this POC actually demonstrated.

## How to read this

Claims are labelled by the strength of evidence behind them:

- **[Demonstrated]** — built and executed in this POC.
- **[Blocked]** — could not be executed here; the reason is stated.
- **[Assessed]** — reasoned from platform documentation and the architecture, not executed.

The POC could not create an Amazon Connect instance (ADR-0004), so every claim about live
telephony behaviour is **[Assessed]**, not demonstrated. That materially limits the
strength of the conclusion and is reflected in it.

---

## The question that actually matters

Not "which platform has more features", but:

> **How much contact-centre responsibility does UCC have to own?**

Every responsibility UCC absorbs is code Infinize writes, tests, scales, secures, staffs
and operates — forever, across every tenant.

| Responsibility | Vapi + Twilio | Amazon Connect |
|---|---|---|
| Telephony / PSTN | Twilio | Connect |
| IVR / call flow | UCC builds it | Connect contact flows |
| **Queueing** | **UCC builds it** | Connect |
| **Agent presence & state** | **UCC builds it** | Connect |
| **Routing engine** | **UCC builds it** | Connect routing profiles |
| **Agent desktop** | **UCC builds it** | Connect CCP (embeddable) |
| **Warm/cold transfer** | **UCC builds it** | Connect |
| **Callback / queued callback** | **UCC builds it** | Connect |
| **Call recording + storage** | **UCC builds it** | Connect → S3 |
| **Real-time supervisor metrics** | **UCC builds it** | Connect + Contact Lens |
| AI conversation | Vapi | Bedrock (UCC orchestrates) |

Eight rows in bold. That is the substance of the decision, and it is an architectural fact
rather than a matter of preference.

---

## Dimension-by-dimension

### Inbound
**[Assessed]** Both handle inbound. Twilio delivers a webhook and everything after that —
IVR, hold, queue, agent selection — is UCC's problem. Connect delivers the call into a
contact flow with queueing, hold, whisper and transfer as configured blocks.
**Connect, decisively.**

### Outbound
**[Demonstrated, simulated telephony]** The POC ran a deadline-reminder campaign that
produced a `UccCall` and `UccTicket` per contact. **[Assessed]** Twilio dials well;
Connect adds native outbound campaigns with pacing, answering-machine detection and
compliance controls that would otherwise be UCC's to build. **Connect for campaigns,
parity for simple dialling.**

### AI conversation quality
**[Demonstrated]** Bedrock with Claude Sonnet 4.5 handled tool use, disambiguation and
refusal correctly on the first pass. Vapi is a purpose-built voice-agent platform with
tuned turn-taking, barge-in and sub-second latency — genuinely good at the thing it does.
**Honest read: Vapi is likely better at raw voice-agent UX out of the box.** Bedrock gives
more control over reasoning, tool authorization and model choice. This is the dimension
where the incumbent is strongest, and the POC did not test voice latency at all because
telephony was simulated.

### Telephony quality
**[Blocked]** Not tested. Twilio's carrier network is mature and well regarded. Connect
runs on AWS's own network. **Inconclusive from this POC.**

### Routing
**[Demonstrated]** UCC resolves the department (a business rule it should own) and hands the
contact to a Connect queue; Connect selects the agent. With Twilio, UCC would own the
entire routing engine including skills, priority, overflow and agent selection.
**Connect, decisively.**

### Queues
**[Assessed]** Connect provides them natively with real-time metrics. Twilio TaskRouter
exists and is capable, but is a separate product with its own model to learn and operate.
**Connect.**

### Callbacks
**[Demonstrated, simulated]** Full lifecycle: request → queue → agent completion → timeline.
**[Assessed]** Connect provides queued callback natively, preserving queue position. On
Twilio this is UCC state plus a scheduler plus a dialler. **Connect.**

### Transfer
**[Assessed]** Connect supports warm and cold transfer and conference natively. Twilio
provides the primitives; the orchestration is UCC's. **Connect.**

### Agent experience
**[Demonstrated]** A working agent workspace was built: context, accept, notes, resolve,
with server-side enforcement that only the assigned agent can act. **[Assessed]** Connect
CCP embeds and brings softphone, presence and transfer controls; on Twilio that is all
bespoke. **Connect.**

### Supervisor experience
**[Demonstrated]** Live floor, queue depth, AI-vs-agent split, escalations, open tickets,
realtime feed. **[Assessed]** Connect adds native real-time and historical metrics plus
Contact Lens sentiment and compliance analytics. On Twilio this is entirely bespoke.
**Connect.**

### Recording
**[Blocked]** Not captured — no live instance. **[Assessed]** Connect records to S3 with
lifecycle and encryption as configuration. UCC stores only metadata; the POC implements
this and stores no binaries in DynamoDB. On Twilio, recording storage, lifecycle and
retention are UCC's to build. **Connect.**

### Transcript
**[Demonstrated]** A normalized transcript spanning AI and agent segments is exposed from
the ticket. **[Assessed]** Contact Lens provides real-time transcription and analytics
natively; Vapi provides AI-segment transcripts but the human-agent segment would be UCC's
problem. **Connect.**

### Campaigns
**[Assessed]** Connect has a native outbound campaign product. Twilio requires assembling
one. **Connect.**

### Security
**[Demonstrated]** This is the POC's strongest result, and it is largely architecture-
independent — but the platform makes it easier or harder. Authorization is enforced
server-side in UCC, never in the prompt (ADR-0002). A live prompt-injection attempt against
real Bedrock was refused. Cross-tenant access is structurally impossible at the repository
layer. With Bedrock, inference happens inside the AWS account under IAM, with no data
leaving to a third party. Vapi is an additional processor handling voice containing student
PII, requiring its own DPA and review. **Connect + Bedrock, on data governance.**

### Scalability
**[Assessed]** Connect is used at very large scale and scales elastically. Twilio also
scales; what does not scale cheaply is the bespoke contact-centre layer UCC would own.
**Connect.**

### AWS integration
**[Demonstrated]** DynamoDB, S3, IAM, SSM, Secrets Manager, CloudWatch and Bedrock compose
in one CDK stack with one IAM role and one trust boundary. **Connect, decisively.**

### Operational complexity
**Mixed, and the most honest section.** Connect concentrates operations in AWS: one
provider, one bill, one IAM model. But Connect is a large product with a real learning
curve, contact flows are edited in a GUI that resists code review and version control, and
— as this POC proved — **it can be blocked entirely by account-level governance.** Vapi and
Twilio are markedly faster to get running. The POC lost its Connect capability to an SCP
and never recovered it; that is an operational risk that belongs in the decision.

### Vendor count
Vapi + Twilio + AWS = three vendors, three contracts, three security reviews, three status
pages. Connect + Bedrock = one. **Connect.**

### Cost model
**[Assessed — not measured]** Connect: per-minute usage, no seat licences. Vapi: per-minute
AI pricing on top of Twilio per-minute telephony, plus AWS for everything else. Directionally
Connect + Bedrock should be cheaper at volume by removing a margin layer, but **no cost
modelling was performed in this POC** and this claim should not be presented as evidence.

### Observability
**[Demonstrated]** Structured logs with correlation ids and enforced redaction; every state
change on an append-only timeline. **[Assessed]** Connect adds CloudWatch metrics, Contact
Trace Records and Contact Lens in the same account as the rest of the telemetry. With three
vendors, correlation spans three systems. **Connect.**

### Failure handling
**[Demonstrated]** KB failure escalates; application-API failure escalates and never
fabricates; Bedrock failure falls back to human escalation. All covered by tests.
**[Assessed]** Connect contact flows provide a telephony-level fallback that survives the
application being down — with Vapi, if the AI layer is unavailable mid-call the fallback is
whatever UCC built. **Connect.**

### UCC integration
**[Demonstrated]** Every contact produces a `UccCall` and `UccTicket`; the provider contact
id resolves to the UCC case in one read; the timeline is idempotent under redelivery. This
works with either provider — the `TelephonyProvider` port exists precisely to prove that.
**Parity, by design.**

---

## Scorecard

| Dimension | Winner | Evidence |
|---|---|---|
| Inbound | Connect | Assessed |
| Outbound | Connect | Demonstrated (simulated) |
| AI conversation UX | **Vapi** | Assessed |
| AI control & governance | Bedrock | Demonstrated |
| Telephony quality | Inconclusive | Blocked |
| Routing | Connect | Demonstrated |
| Queues | Connect | Assessed |
| Callbacks | Connect | Demonstrated (simulated) |
| Transfer | Connect | Assessed |
| Agent experience | Connect | Demonstrated + Assessed |
| Supervisor experience | Connect | Demonstrated + Assessed |
| Recording | Connect | Blocked |
| Transcript | Connect | Demonstrated + Assessed |
| Campaigns | Connect | Assessed |
| Security & data governance | Connect + Bedrock | Demonstrated |
| Scalability | Connect | Assessed |
| AWS integration | Connect | Demonstrated |
| Operational complexity | **Vapi + Twilio** | Demonstrated (the SCP block) |
| Vendor count | Connect | Structural |
| Cost model | Connect (unverified) | Not measured |
| Observability | Connect | Demonstrated + Assessed |
| Failure handling | Connect | Demonstrated |
| UCC integration | Parity | Demonstrated |

---

## Where Amazon Connect is genuinely worse

Stating this plainly, because a comparison that finds no weaknesses is not a comparison.

1. **It can be governance-blocked.** This POC could not create an instance because of an
   organisation SCP. Twilio needs an API key. This is a real, experienced cost.
2. **Contact flows are GUI-authored.** They resist code review, diffing and CI. Exporting
   and importing JSON is possible but awkward, and flow logic tends to drift from the code
   that depends on it.
3. **Steeper learning curve.** Instances, routing profiles, security profiles, hours of
   operation, quick connects — a lot of concepts before the first call.
4. **Slower to first call.** Vapi to a working voice agent is a short exercise. Connect
   involves instance provisioning, number claiming and flow authoring.
5. **Voice-agent UX is not turnkey.** Vapi has invested specifically in turn-taking,
   interruption and latency. Bedrock plus Connect gives control, not a tuned voice agent —
   closing that gap is real work, and this POC did not attempt it.
6. **Regional availability** is narrower than Twilio's global footprint.

## Where Vapi + Twilio is genuinely better

1. Time to first working voice agent.
2. Voice-agent conversational UX out of the box.
3. No AWS account governance in the critical path.
4. Simpler mental model for a small team.

---

## Recommendation

**Amazon Connect + Bedrock + UCC is the stronger foundation — for a contact centre.**

The decisive argument is not feature count; it is the ownership table at the top. On the
Vapi + Twilio path, UCC must build and operate queueing, routing, agent state, transfer,
callback, recording storage and supervisor analytics. That is a contact-centre platform,
and building one is not Infinize's business. On the Connect path those are configuration.

The security result reinforces it: a POC where authorization is enforced in UCC, inference
runs inside the AWS account under IAM, and student PII never reaches a third-party
processor is materially easier to defend to a university's information-security review.

**Three caveats that must not be dropped when this is presented:**

1. **Live telephony was never exercised.** The SCP block means inbound audio, DTMF, real
   queue behaviour and recording capture remain unproven here. The recommendation rests on
   architecture and platform capability, not on a call that was placed.
2. **Voice UX is the incumbent's strength**, and this POC did not measure it. If the
   product is primarily a voice agent rather than a contact centre, that conclusion could
   reverse.
3. **No cost modelling was done.** Do not present cost as a finding.

**Suggested next step:** unblock the SCP (ADR-0004), stand up one Connect instance, claim
one number, and re-run the nine demo scenarios over real telephony with
`UCC_TELEPHONY=connect`. That is a small amount of work and it converts the largest
**[Assessed]** column in this document into **[Demonstrated]**.

---

## Addendum — the voice-quality gap may be closable inside AWS

The conclusion above credits Vapi with a real lead on conversational voice quality. Amazon
Nova Sonic, a speech-to-speech model already available in our Bedrock account, is the
AWS-native answer to that gap.

It has now been **measured** ([nova-sonic-assessment.md](./nova-sonic-assessment.md)):
**433 ms** to first audio after the caller stops speaking, working server-side tool use, and
per-role transcripts — with our authorization gate refusing an unverified caller mid-call,
in a conversation that never left audio.

That closes most of the gap this comparison credited to Vapi, without leaving AWS. Three
qualifications: it works only on `nova-2-sonic-v1:0` (v1 never called the tool); it requires
long-lived stateful streams rather than our current stateless turns, which rules out Lambda;
and the Amazon Connect integration path is not yet confirmed. The voice-quality row should be
read as **narrowing, on evidence** rather than settled.
