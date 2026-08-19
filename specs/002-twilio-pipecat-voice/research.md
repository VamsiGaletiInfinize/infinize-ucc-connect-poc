# Phase 0 Research — Twilio + Pipecat voice pipeline

**Date:** 2026-08-19 · **Feature:** `002-twilio-pipecat-voice`

Every finding below was obtained by installing the pinned dependency into a Python 3.12
virtualenv and executing against it. Nothing here is recalled from memory; where a claim
could not be executed, it is labelled as unverified.

Reproduce with:

```bash
cd services/voice-pipecat
uv venv .venv --python 3.12
uv pip install --python .venv/Scripts/python.exe -r requirements.txt
```

---

## R1 — The existing `bot.py` does not run. What exactly is broken?

**Decision:** Migrate `bot.py` to the 1.0.0 module layout rather than rewriting it. The
design is sound; the API surface moved.

**Evidence:** `python -c "import bot"` fails at the first Pipecat import. Probing each
import individually:

| `bot.py` import / call | 1.0.0 reality | Fix |
|---|---|---|
| `pipecat.processors.aggregators.openai_llm_context.OpenAILLMContext` | module absent | `pipecat.processors.aggregators.llm_context.LLMContext` |
| `pipecat.transports.network.fastapi_websocket` | module absent | `pipecat.transports.websocket.fastapi` |
| `pipecat.services.aws_nova_sonic.aws.AWSNovaSonicLLMService` | module absent | `pipecat.services.aws.nova_sonic.llm.AWSNovaSonicLLMService` |
| `llm.create_context_aggregator(context)` | **method does not exist anywhere in 1.0.0** | construct `LLMContextAggregatorPair(context)` directly |
| `TwilioFrameSerializer(..., auto_hang_up=False)` | not a constructor kwarg | `params=TwilioFrameSerializer.InputParams(auto_hang_up=False)` |
| `pipecat.serializers.twilio` | ok | — |
| `pipecat.audio.vad.silero` | ok | — |
| `pipecat.adapters.schemas.function_schema` | ok | — |
| `PipelineParams(audio_in_sample_rate=..., audio_out_sample_rate=...)` | ok — both still exist | — |

**Alternatives considered:** Rewrite from a current Pipecat example. Rejected — the existing
file already encodes decisions worth keeping (refusing to run without a case id, disabling
auto hang-up so an escalation is not cut off, relaying tool denials verbatim). Those are the
expensive parts; the imports are the cheap part.

---

## R2 — Which dependency extras are actually required?

**Decision:** `pipecat-ai[aws,aws-nova-sonic,silero,webrtc]==1.0.0`.

**Evidence:** The pinned `requirements.txt` asks for `[aws,silero,twilio,webrtc]`. Two
things are wrong with that:

1. `uv` reports: `warning: The package pipecat-ai==1.0.0 does not have an extra named
   twilio`. The extra was silently ignored. Querying package metadata confirms 72 extras
   exist and `twilio` is not among them — the Twilio serializer ships in core.
2. **`[aws]` is not sufficient for the speech-to-speech path.** With only `[aws]`,
   importing the Nova Sonic service fails:

   ```
   ERROR pipecat.services.aws.nova_sonic.llm - Exception: No module named 'aws_sdk_bedrock_runtime'
   ERROR In order to use AWS services, you need to `pip install pipecat-ai[aws-nova-sonic]`.
   ```

   Package metadata: `aws_sdk_bedrock_runtime~=0.4.0; python_version >= "3.12" and extra ==
   "aws-nova-sonic"`.

After installing the corrected extras, the import succeeds — verified, not assumed:

```
NOVA SONIC IMPORT OK -> AWSNovaSonicLLMService
```

**Consequence:** **Python 3.12 or newer is a hard requirement**, because the Nova Sonic
dependency is gated on `python_version >= "3.12"`. The host's default interpreter is 3.14,
which is newer than the ecosystem is comfortable with; 3.12 is pinned for the virtualenv.

**Alternatives considered:** Skipping `aws-nova-sonic` and shipping only the cascaded
pipeline. Rejected — constitution Principle XI requires both topologies.

---

## R3 — Cascaded provider selection

**Decision:** Amazon Transcribe (STT) → Bedrock Claude (LLM) → Amazon Polly (TTS), per the
clarification session.

**Evidence of availability in 1.0.0** — all three classes exist and import cleanly:

| Stage | Class | Notes |
|---|---|---|
| STT | `AWSTranscribeSTTService` | subclasses `WebsocketSTTService`, so it streams rather than batching |
| LLM | `AWSBedrockLLMService` | same Converse-family API the text path already uses |
| TTS | `AWSPollyTTSService` | — |

**Rationale beyond the clarification:**

- **No new credentials.** `.env` today holds Twilio secrets and nothing else — no STT or TTS
  keys of any kind. Choosing Deepgram or Cartesia would block the cascaded pipeline on
  vendor signup rather than on code.
- **Credential mechanism already works — for these three.** `AWSTranscribeSTTService`,
  `AWSBedrockLLMService` and `AWSPollyTTSService` all construct `aioboto3.Session()` with no
  arguments, which resolves through the standard AWS credential chain and therefore honours
  `AWS_PROFILE`. That is exactly how this repository already authenticates locally
  (`README.md`), so nothing new is introduced on the cascaded path.

  > **Correction, found during implementation.** This does **not** extend to Nova Sonic, as
  > an earlier draft of this document claimed. `AWSNovaSonicLLMService.__init__` takes
  > `access_key_id` and `secret_access_key` as *required* keyword arguments and never
  > touches the credential chain. The s2s path therefore resolves the chain itself
  > (`boto3.Session().get_credentials()`) and passes the frozen credentials in, so
  > `AWS_PROFILE` still works and no access key has to be added to `.env`. See
  > `_resolve_aws_credentials` in `services/voice-pipecat/pipeline.py`.
- **Sample rate lines up.** `AWSTranscribeSTTService` accepts 8000 or 16000 Hz and clamps
  anything else to 16000. Twilio Media Streams is 8 kHz μ-law, so the cascaded input path
  needs no resampling — one less transformation in the latency budget.
- **Inference stays put.** Keeping the LLM on Bedrock means the cascaded and text paths
  answer from the same model, so any observed difference is attributable to the voice layer
  rather than to a model swap.

**Alternatives considered:** Deepgram + Cartesia, the most common Pipecat pairing and
probably faster. Rejected for the POC on credential grounds, not technical ones. Because
FR-022 makes each stage a configuration value, this is a cheap experiment to run later —
and SC-003 is the trigger for running it.

**Risk, stated plainly:** these are not the lowest-latency providers available. If the
cascaded topology misses SC-003 (2.5 s), the first remedy is swapping a stage, not
redesigning the pipeline. That is the whole point of Principle XI.

---

## R4 — How the two topologies share one pipeline

**Decision:** One transport, one serializer, one tool bridge, one context. A single factory
returns the ordered processor list for the selected mode; everything either side of it is
identical.

```
cascaded          transport.in → STT → user_agg → LLM → TTS → transport.out → assistant_agg
speech-to-speech  transport.in →       user_agg → S2S →       transport.out → assistant_agg
```

**Evidence this is structurally possible:** both `AWSBedrockLLMService` and
`AWSNovaSonicLLMService` derive from `LLMService`, so both expose the same
`register_function(name, handler)` used to wire tools, and both consume the same
`LLMContext` carrying a `ToolsSchema`. The tool bridge therefore does not vary by mode.

**One real asymmetry, and it must not be hidden:** Nova Sonic takes its system prompt as a
constructor argument (`system_instruction=`), whereas the cascaded path takes it as a
message inside `LLMContext`. The prompt text must come from one versioned artifact and be
handed to whichever mechanism the mode requires — otherwise the two topologies are being
compared with two different prompts, which would invalidate the measurement.

**Alternatives considered:** Two separate services, one per topology. Rejected — duplicating
the transport, serializer, session binding and tool bridge is exactly how the two paths
would drift apart, and a drifted comparison answers nothing.

---

## R5 — Per-stage latency instrumentation

**Decision:** Enable Pipecat's built-in metrics and attach observers; add one custom
observer that re-emits into the UCC structured-logging format with the correlation id.

**Evidence — most of this is already built:**

- `PipelineParams(enable_metrics=True)` produces `MetricsFrame`s carrying
  `TTFBMetricsData` and `ProcessingMetricsData` **per processor**, which yields time to
  first transcript, first token and first audio without any manual timing.
- `PipelineTask(..., observers=[...])` accepts observers; 1.0.0 ships
  `UserBotLatencyObserver` (caller-stops-speaking to bot-starts-speaking — the number
  SC-002/SC-003 are written against) and `TurnTrackingObserver` (turn boundaries).
- `BaseObserver` sees every frame without being inserted into the pipeline, so measurement
  does not alter the thing measured.

**What must still be written:** tool round-trip duration (FR-035), which is timed in the
tool handler because it is a UCC round trip rather than a pipeline stage; and the mapping
from Pipecat's loguru output into the repo's structured JSON with `uccCallId` on every line.

**Alternatives considered:** Hand-rolled timers around each stage. Rejected — more code,
less accurate, and it would miss the frames that never reach a stage.

---

## R6 — Authenticating and binding the voice bridge

**Decision:** Two layers, per the clarification. A static service credential proves "this is
the voice pipeline"; a short-lived per-call token proves "this session is entitled to this
case". Both are required on every tool call.

**Delivery mechanism:** UCC already emits the TwiML that opens the media stream, and already
attaches `uccCallId` and `tenantId` as `<Stream>` parameters. The per-call token is minted at
that moment and attached the same way. Twilio delivers custom parameters on the stream
`start` message, which the pipeline already reads. **No new transport, no new endpoint, no
new handshake.**

**Rationale for rejecting a shared secret alone:** it authenticates the *service* but not the
*session*. Any holder could call `POST /api/calls/<any-id>/tool` and read any case. That is
Principle X's hole reopened one layer down, which is worse than the current state because it
would look closed.

**Threat honestly stated:** the per-call token transits Twilio, since it rides in the TwiML.
Anyone able to read the TwiML response or the stream start frame can impersonate that one
session for the life of that one call. Acceptable for a POC over TLS with a short expiry;
a production design would exchange a nonce for a token over a direct channel instead. This
belongs in `docs/security.md`, not in a comment.

**Alternatives considered:** mutual TLS (strongest service identity, but needs a certificate
story in local development and still does not bind to a call); per-call token alone (no
service identity to revoke, and a leaked token needs nothing else).

---

## R7 — Who speaks first

**Decision:** The telephony layer speaks a fixed greeting in the TwiML while the media stream
is still being established; the assistant then listens.

**Rationale:** There is roughly a second between Twilio answering and the stream carrying
audio. A caller who says "hello?" into that window loses their opening utterance, and the
assistant's first real input becomes a fragment. The existing ConversationRelay path already
solves this with `welcomeGreeting`; matching it keeps the two paths comparable.

**Secondary benefit:** it removes an asymmetry between the topologies. Nova Sonic has its own
mechanism for triggering an unprompted first utterance (the service tracks
`_is_assistant_response_trigger_needed` internally); the cascaded path would need a queued
TTS frame. Greeting from TwiML means neither mechanism is used and both modes behave
identically at call open.

**Cost, accepted:** the greeting is fixed text in a Polly voice that may differ from the
assistant's, so the caller may hear a voice change a few seconds in.

---

## R8 — Deployment shape

**Decision:** Local only for this feature. Long-lived stateful streams, one process, two
tunnelled ports.

**Rationale:** unchanged from `docs/nova-sonic-assessment.md` and constitution Principle
VIII — a bidirectional stream per active call forecloses Lambda, makes concurrent open
streams the scaling unit, and makes connection draining a deployment concern. None of that
needs solving to answer this POC's question, and §22 of the brief says local first.

**Consequence for development:** two public URLs are now required (UCC API and the voice
service). On a rotating free tunnel this doubles the re-pointing work after every restart.

**Unverified:** Pipecat Cloud as the eventual host. Not evaluated; out of scope.

---

## Summary of what changed because of this research

| Belief before | After executing |
|---|---|
| `bot.py` needs its imports updated | Also `create_context_aggregator` is gone entirely, and the serializer's params moved |
| `requirements.txt` is roughly right | It requests a nonexistent extra and **omits the one Nova Sonic needs** |
| Nova Sonic works on the pinned version | Only after adding `[aws-nova-sonic]`; and it requires Python ≥ 3.12 |
| Latency instrumentation must be written | Largely built in — enable metrics, attach shipped observers |
| AWS credentials may need handling | `aioboto3.Session()` already honours `AWS_PROFILE`; nothing to add |
