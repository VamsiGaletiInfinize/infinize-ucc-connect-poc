# Nova Sonic assessment

Amazon Nova Sonic is a speech-to-speech model: audio in, audio out, with turn-taking handled
inside the model rather than stitched from STT → LLM → TTS. It is available in Bedrock in
account `279078306711` today — it appeared in the model enumeration at the start of this
POC, alongside `amazon.nova-2-sonic-v1:0`.

This matters because conversational voice quality is **the one dimension where this POC
concluded Vapi is genuinely ahead** ([comparison](./vapi-twilio-vs-connect.md)). If Nova
Sonic closes that gap without leaving AWS, it removes the strongest argument for keeping
Vapi.

## Results — measured, not assumed

Executed against live Bedrock in account `279078306711` via
[`scripts/nova-sonic-spike.ts`](../scripts/nova-sonic-spike.ts).

| Question | Result |
|---|---|
| Available in our account? | **Yes** — `amazon.nova-sonic-v1:0` and `amazon.nova-2-sonic-v1:0` |
| Server-side tool use? | **Yes — on `nova-2-sonic` only.** `nova-sonic-v1` never emitted a tool request across three runs |
| Does the authorization gate still hold? | **Yes — proven end to end** |
| Time to first audio (no tool call) | **433 ms** after the caller stops speaking |
| Time to first audio (with tool round-trip) | **1109 ms**, including our server-side adjudication |
| Transcript usable for the UCC timeline? | **Yes** — per-role text output, caller ASR and assistant separately |
| Barge-in primitives? | **Yes** — `userSpeechStart` / `userSpeechEnd` events |
| Native Amazon Connect integration path | **Still uncertain** — see the caveat below |

### The decisive result

The complete loop ran in speech-to-speech, with no text channel anywhere:

```
caller audio ("what is the status of my application APP2026001?")
    -> Nova Sonic ASR + reasoning
    -> toolUse: get_application_status({"applicationId":"APP2026001"})
    -> OUR server-side gate, reading persisted state
    -> DENY (NOT_VERIFIED)
    -> model speaks the refusal back as audio
```

The model asked, the gate refused, and the model relayed the refusal without ever receiving
the data. **The security property of ADR-0002 survives the move to speech-to-speech**, because
the gate never cared which model was asking.

### Version difference matters

`nova-sonic-v1` did not emit a tool request in any run, including one where the caller spoke
the application ID aloud and the prompt instructed the model to call the tool. `nova-2-sonic`
did so immediately. **Use `nova-2-sonic-v1:0`.** On v1, every protected flow would have to
leave the voice channel — which would have been disqualifying.

### One caution from the transcript

Having been refused, the model improvised its own verification procedure, asking for full
name, date of birth, contact number and email. That is **not** our verification flow, which
is a one-time passcode. No protected data leaked and the gate held, so this is a
prompt-engineering gap rather than a security hole — but it shows that a speech-to-speech
model left to fill silence will invent plausible-sounding process. Production use needs the
tool's refusal message to state the remediation explicitly, as the Converse path already
does.

### A methodology note

An early version of this spike told the model in its system prompt that the caller was
unverified. The model then declined conversationally and never called the tool — which would
have read as "Nova Sonic does not support tool use". The prompt was leaking the answer. The
current version withholds verification status so the model must consult the tool to learn
anything. Worth remembering when interpreting any negative result from this harness.

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

This is now **verified rather than argued**: the spike run above shows `nova-2-sonic`
emitting a tool request and our gate refusing it, in a conversation that never left audio.
Note that this holds only on `nova-2-sonic` — on `nova-sonic-v1` the model never called the
tool, which would have limited it to public FAQ.

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

On the evidence: **Nova Sonic (v2) is a credible AWS-native answer to the voice-quality gap.**
Sub-second first audio, working server-side tool use, per-role transcripts and barge-in
primitives — the things that made Vapi feel ahead — are present and measured.

That materially weakens, though does not by itself settle, the strongest remaining argument
for keeping Vapi. Two things still stand between this and a recommendation:

1. **Unblock Amazon Connect** (SCP `p-qocf1ngi`). Unchanged as the highest-value action.
   Nova Sonic improves the AI leg; it says nothing about queues, routing or agent state.
2. **Confirm the Connect ↔ Nova Sonic integration path** against current AWS documentation.
   If it is still Kinesis Video Streams rather than native, the integration effort is
   material and partly offsets the latency advantage measured here.

The architectural cost above — long-lived stateful streams instead of stateless turns —
applies regardless, and should be priced into any adoption decision.
