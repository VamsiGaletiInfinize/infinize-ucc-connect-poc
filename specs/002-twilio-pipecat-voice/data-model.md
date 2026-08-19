# Phase 1 Data Model — Twilio + Pipecat voice pipeline

**Feature:** `002-twilio-pipecat-voice`

This feature introduces **no persistent entities**. The durable domain model — `UccCall`,
`UccTicket`, `UccEvent`, `Caller`, `Application`, `VerificationSession` — already exists in
`packages/types` and is owned by UCC. The voice service persists nothing (constitution
Principle X).

What follows are the in-process and on-the-wire structures the voice leg introduces, plus
the one new short-lived server-side record.

---

## 1. `VoiceSession` (in-memory, voice service)

One per open media stream. Lives from stream `start` to socket close. Never written to disk.

| Field | Type | Source | Notes |
|---|---|---|---|
| `stream_sid` | string | Twilio `start` frame | Twilio's id for the media stream |
| `call_sid` | string | Twilio `start` frame | Twilio's id for the call |
| `ucc_call_id` | string | `<Stream>` custom parameter | **Required.** Absent ⇒ refuse the session (FR-006) |
| `tenant_id` | string | `<Stream>` custom parameter | Carried for logging and future multi-tenancy |
| `session_token` | string | `<Stream>` custom parameter | **Required.** Per-call bearer for the tool bridge (FR-028) |
| `mode` | `cascaded` \| `s2s` | service configuration | Fixed at startup, not per call |
| `escalated` | bool | set by a tool result | Decides whether the service ends the UCC call itself |
| `started_at` | timestamp | stream open | Baseline for session-duration logging |

**Lifecycle**

```
opening ──start frame──▶ bound ──first audio──▶ conversing ──┬─ caller hangs up ─▶ closed(COMPLETED)
   │                                                          ├─ tool escalates ──▶ closed(ESCALATED)
   │                                                          └─ pipeline fails ──▶ closed(FAILED)
   └── no ucc_call_id or no session_token ─▶ refused (socket closed, code 1008)
```

**Invariants**

- `ucc_call_id` is set exactly once, at bind, and never changes.
- A session in `refused` executes no tool and emits no audio.
- On `closed(ESCALATED)` the service does **not** end the UCC call — the TwiML action URL
  owns the transfer, and ending the call would drop the caller mid-handoff.
- On `closed(COMPLETED)` and `closed(FAILED)` the service ends the UCC call with the
  corresponding reason (FR-005).

---

## 2. `CallSessionToken` (short-lived, UCC side)

The one genuinely new server-side record. Minted when UCC generates the TwiML that opens
the stream; presented by the voice service on every tool call.

| Field | Type | Notes |
|---|---|---|
| `token` | string | Opaque, high-entropy. Never logged, never rendered in the UI |
| `ucc_call_id` | string | The single case this token authorises. Not a list |
| `tenant_id` | string | Carried so the gate does not re-derive it from the request |
| `issued_at` | timestamp | — |
| `expires_at` | timestamp | Short — a call, not a session |

**Validation rules**

- A tool request MUST present both a valid service credential and a valid token (FR-027,
  FR-028). Either alone is rejected.
- The token's `ucc_call_id` MUST equal the call id in the request path. A mismatch is
  rejected even when both credentials are individually valid — this is the binding.
- A token MUST be rejected after `expires_at`, and after the call it belongs to has ended
  (FR-029).
- Storage is the existing tenant-partitioned store, so a token cannot be read across a
  tenant boundary. It is short-lived state, not a new persistence concern.

**Explicitly not**: a caller identity, an agent identity, or a verification state. It proves
*which case a stream may act on* and nothing else. Verification remains entirely
server-side, unchanged (Principle III).

---

## 3. `PipelineConfig` (startup configuration)

Read once at startup. An invalid combination MUST prevent the service from starting rather
than degrading silently (FR-026).

| Key | Values | Default | Notes |
|---|---|---|---|
| `UCC_VOICE_MODE` | `cascaded` \| `s2s` | `cascaded` | The Principle XI switch |
| `UCC_STT_PROVIDER` | `aws` | `aws` | Cascaded only. Enum exists so a second value is a config change |
| `UCC_LLM_PROVIDER` | `bedrock` | `bedrock` | Cascaded only |
| `UCC_TTS_PROVIDER` | `aws` | `aws` | Cascaded only |
| `NOVA_SONIC_MODEL_ID` | model id | `amazon.nova-2-sonic-v1:0` | s2s only. v1 never emitted tool requests |
| `UCC_API_BASE` | url | `http://localhost:4000` | — |
| `UCC_VOICE_SERVICE_TOKEN` | secret | *none* | **Required.** Absent ⇒ refuse to start (FR-030) |
| `AWS_REGION` | region | `us-east-1` | Credentials resolve via the standard chain |

**Validation rules**

- `UCC_VOICE_MODE=s2s` with a Nova Sonic model that is unavailable ⇒ fail at startup, not
  on the first call.
- A provider key naming an unimplemented provider ⇒ fail at startup with the list of
  supported values. Never fall back to the default (FR-026).
- Missing `UCC_VOICE_SERVICE_TOKEN` ⇒ refuse to start. Never fall back to an open channel.

---

## 4. `ToolInvocation` (transient, per call)

Not persisted by the voice service; produced for logging and handed to UCC for execution.

| Field | Type | Notes |
|---|---|---|
| `name` | string | Must exist in the catalogue fetched at session start |
| `arguments` | object | Model-supplied. **Untrusted** — validated server-side by UCC |
| `ucc_call_id` | string | From the session, never from the model |
| `duration_ms` | number | Round trip, measured in the handler (FR-034) |
| `ok` | bool | From the UCC response |
| `control` | `ESCALATED` \| `CALLBACK_CREATED` \| `VERIFICATION_PENDING` \| null | Drives session state |

**Invariant:** `ucc_call_id` is taken from the bound session. A model that supplies a call id
in its arguments is ignored — the model cannot select which case it operates on.

---

## 5. `TurnMetrics` (transient, per turn)

The unit SC-002 through SC-005 are measured against.

| Field | Source |
|---|---|
| `ttf_transcript_ms` | `TTFBMetricsData` on the STT processor (cascaded only) |
| `ttf_token_ms` | `TTFBMetricsData` on the LLM processor (cascaded only) |
| `ttf_audio_ms` | `TTFBMetricsData` on the TTS processor, or on the s2s service |
| `end_to_end_ms` | `UserBotLatencyObserver` — caller stops speaking to bot starts speaking |
| `interrupt_to_silence_ms` | interruption frame to output stop (SC-005) |
| `tool_ms` | sum of `ToolInvocation.duration_ms` in the turn |
| `mode` | so cascaded and s2s rows are comparable |
| `ucc_call_id` | correlation (FR-032) |

**Note on comparability:** in `s2s` the first three collapse into `ttf_audio_ms`, because the
model does all three. Reports MUST NOT present a blank cascaded-style breakdown for s2s as
if the stages were instantaneous.

---

## Redaction rules (FR-036)

Never emitted in any log line, in either service:

- `session_token`, `UCC_VOICE_SERVICE_TOKEN`, any AWS credential
- verification passcodes, in any form, including inside a transcript fragment
- full caller phone numbers (the existing redacting logger already truncates these)
- application record contents — the *fact* of a tool call is logged, its payload is not
