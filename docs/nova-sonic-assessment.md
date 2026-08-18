# Nova Sonic assessment

Amazon Nova Sonic is a speech-to-speech model: audio in, audio out, with turn-taking handled
inside the model rather than stitched from STT → LLM → TTS. It is available in Bedrock in
account `279078306711` today — it appeared in the model enumeration at the start of this
POC, alongside `amazon.nova-2-sonic-v1:0`.

This matters because conversational voice quality is **the one dimension where this POC
concluded Vapi is genuinely ahead** ([comparison](./vapi-twilio-vs-connect.md)). If Nova
Sonic closes that gap without leaving AWS, it removes the strongest argument for keeping
Vapi.

## Status of this assessment

| Question | Status |
|---|---|
| Is the model available in our account? | **Confirmed** — enumerated in Bedrock |
| Does it preserve server-side tool authorization? | **Unverified** — spike written, not yet run |
| Time to first audio byte | **Unmeasured** |
| Native Amazon Connect integration path | **Uncertain** — see the caveat below |

[`scripts/nova-sonic-spike.ts`](../scripts/nova-sonic-spike.ts) answers the first three in
one run. It synthesizes a caller utterance with Polly, opens the bidirectional stream,
hands the model our real `get_application_status` tool, and routes any resulting tool
request through the real authorization gate. It has **not been executed** — every attempt
coincided with an expired session token. Do not treat anything below marked *unverified* as
evidence.

## The finding that matters most, and it is not voice quality

Nova Sonic requires a **long-lived, stateful bidirectional stream per active call**. Our
current design is stateless per turn: `POST /api/calls/:id/turn` takes an utterance, runs a
Converse round-trip with tools, persists the outcome and returns. Any instance can serve any
turn, because all state lives in DynamoDB.

That property is why the architecture scales the way [architecture.md](./architecture.md)
claims it does. Adopting Nova Sonic gives it up:

| | Current (Converse) | With Nova Sonic |
|---|---|---|
| Session | Stateless per turn | Sticky, open for the whole call |
| Compute | Lambda or Fargate, freely horizontal | Long-lived processes only — no Lambda |
| A dying instance | Next turn is served elsewhere | **The call drops** |
| Scaling unit | Requests per second | Concurrent open streams |

This is a real architectural cost, and it is easy to miss when the demo is one call on one
laptop. At "100 universities, thousands of agents, millions of calls" it changes the
deployment model: concurrent-stream capacity planning, connection draining on deploy, and a
reconnect strategy for mid-call failures. None of that is prohibitive — it is how every
real-time voice platform works, Vapi included — but it should be a deliberate decision, not
a side effect of picking a nicer-sounding model.

## What it does not change

**The security model survives, by construction.** Authorization lives in the `ToolExecutor`
and `IdentityService`, which read persisted state and know nothing about which model asked
([ADR-0002](./adr/0002-server-side-authorization.md)). Swapping the model that emits tool
requests does not touch the gate. The spike asserts this explicitly rather than assuming it:
it puts an unverified caller through the real gate and requires a `DENY`.

The open question is not whether the gate works — it is whether Nova Sonic emits tool
requests at all in speech-to-speech mode. If it does not, Nova Sonic is limited to public
FAQ, and every protected flow would have to hand off to the text path mid-call. That would
be disqualifying for our use case, where verification and application lookup are the point.

**It does not unblock the Amazon Connect evaluation.** Nova Sonic improves the AI leg. The
reason to choose Connect is the contact-centre leg — queues, routing profiles, agent state,
recording. Those remain blocked by SCP `p-qocf1ngi`. Do not let a successful Nova Sonic
spike be mistaken for progress on the main question.

## The Amazon Connect integration caveat

**Confidence: low. Verify before relying on this.**

To my knowledge, Connect's native AI paths are Amazon Lex (with Lambda fulfilment) and
Contact Lens. Putting a custom model on live call audio has historically meant streaming
media out via Kinesis Video Streams, processing it, and injecting audio back — which adds
both latency and moving parts, and would partly offset the latency Nova Sonic saves.

My knowledge cuts off in May 2026 and AWS ships quickly in this area; a native
Connect ↔ Nova Sonic integration may exist now. **Check current Amazon Connect documentation
before costing this.** If native integration exists, the case strengthens considerably. If it
is still KVS-based, the integration effort is material and should be estimated honestly
before committing.

By contrast, Vapi's entire product is this integration, pre-built.

## Recommendation

Run the spike as soon as a working session token is available — it is about two minutes and
resolves the decisive question. Sequence the decisions in this order:

1. **Unblock Amazon Connect** (SCP `p-qocf1ngi`). Still by far the highest value; nothing
   here displaces it.
2. **Run the Nova Sonic spike.** If tool use works and time-to-first-audio is competitive,
   the voice-quality argument for Vapi largely dissolves.
3. **Confirm the Connect integration path** against current AWS documentation before
   estimating effort.

Only after those three does a platform recommendation on the voice leg rest on evidence
rather than on reasoning.
