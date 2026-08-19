# Phase 0 — Repository inventory and POC boundary

**Date:** 2026-08-19 · **Branch:** `main` · **HEAD:** `b2f71aa`

This is the Phase 0 deliverable required before any implementation: what already exists,
what is real, what is unverified, and where the Twilio + Pipecat POC boundary sits.

The single most important finding: **this is not a greenfield repository.** A complete UCC
control plane, a Twilio telephony adapter, a working ConversationRelay voice path and a
first-draft Pipecat service already exist. The work ahead is *convergence and verification*,
not construction.

---

## 1. Repository structure

```
.specify/          Spec Kit — constitution (v1.0.0) + templates + workflows
.beads/            Beads — 73 issues: 48 closed, 25 open, 24 ready, 1 blocked
specs/001-ucc-connect-poc/   spec.md · plan.md
packages/          types · shared (redacting logger) · config (zod env schema)
services/          store · events · ticketing · calls · identity · verification
                   applications · knowledge · ai · telephony · routing · agents
                   recording · outbound · realtime
                   voice-pipecat/     <- Python; the only non-TypeScript module
apps/ucc-api/      Fastify modular monolith (routes: twilio, voice-bridge, calls,
                   tickets, applications, agent-voice, operations)
apps/ucc-web/      React + TypeScript console (agent + supervisor)
infrastructure/    AWS CDK + CloudFormation (Connect instance template)
data/              Infinize University seed tenant + 5-document public KB corpus
tests/             unit · integration · e2e · security
docs/              14 documents + 6 ADRs
```

Baseline verified this session: `npx vitest run` -> **115 passed / 115**, 10 files, ~2s.

---

## 2. Existing UCC voice architecture

Two voice paths already exist behind one config switch, `UCC_VOICE`:

| Path | Value | STT | Reasoning | TTS | Status |
|---|---|---|---|---|---|
| ConversationRelay | `conversationrelay` (**default**) | Twilio / Deepgram | UCC -> Bedrock Converse per turn | Twilio / Amazon Polly | Implemented; unit + integration tested |
| Pipecat | `pipecat` | — | Amazon Nova Sonic speech-to-speech | — | **Written, never executed — does not import** |

Both emit TwiML from the same `voiceTwiml()` helper, carry the same `uccCallId` /
`tenantId` correlation parameters, and post to the same `/twilio/voice/handoff` action URL.
Only who performs speech recognition and synthesis differs. That is a genuinely good seam.

Critically, **both execute tools through the same UCC gate**, so the security boundary does
not move with the model (ADR-0002).

---

## 3. Existing Twilio implementation

`apps/ucc-api/src/routes/twilio.ts` and `services/telephony/src/twilio-provider.ts`.

Implemented:

- `POST /twilio/voice/inbound` — answer URL; opens `UccCall` + `UccTicket` *before* the
  conversation, so an abandoned call still leaves a case (constitution Principle II)
- `POST /twilio/voice/outbound` — outbound answer URL, correlation ids on the query string
- `GET  /twilio/relay` (websocket) — ConversationRelay `setup` / `prompt` / `interrupt` /
  `error` handling, token-by-token streaming, overlapping-turn guard
- `POST /twilio/voice/handoff` — escalation to TaskRouter enqueue **or** UCC-selected agent
  dial, selectable by `UCC_ROUTING`
- `POST /twilio/voice/agent-dial-status` — time-boxed dial with a no-answer fallback
- `POST /twilio/voice/status` — call progress normalized onto the UCC timeline
- Twilio **signature verification on every webhook**, with `PUBLIC_BASE_URL` authoritative
  behind a tunnel; an explicit opt-out env var exists for local replay only
- Browser softphone via the Twilio Voice JS SDK and short-lived Access Tokens
  (`routes/agent-voice.ts`) — the auth token never reaches the browser
- TaskRouter provisioning from seed data (`scripts/provision-taskrouter.ts`)

Configured in `.env` (values not read): account SID, auth token, workspace / workflow SIDs,
API key pair, TwiML app SID, a dedicated POC phone number, and an ngrok `PUBLIC_BASE_URL`.

A note recorded in `.env`: two other numbers on this account carry **production Vapi traffic
and must not be repointed.**

---

## 4. Existing Vapi implementation

**None in this repository.** Vapi appears only as the incumbent architecture being compared
against, in `docs/vapi-twilio-vs-connect.md`. The live Vapi system runs elsewhere, on the
same Twilio account. Treat those numbers as production and out of scope.

---

## 5. Existing KB, APIs and tooling

**Knowledge base** — `services/knowledge/`. Corpus at `data/knowledge/` (five markdown
documents: admissions, programmes and deadlines, fees / scholarships / aid, hostel and
campus, portal support). Chunked, embedded with Titan Text Embeddings v2, cosine retrieval,
with a deterministic lexical fallback for offline runs (`UCC_RETRIEVAL=lexical`).
Live-verified. **Do not build a second KB.**

**Tool catalogue** — `services/ai/src/tools.ts`, eight tools, already the single source of
truth and already served over HTTP at `GET /api/ai/tools`:

| Tool | Master-prompt requirement it satisfies |
|---|---|
| `search_public_knowledge` | `get_admission_information()` / public KB |
| `get_caller_profile` | — |
| `request_identity_verification` | `verify_identity()` step 1 — issue OTP |
| `verify_identity` | `verify_identity()` step 2 — submit OTP |
| `get_applications` | multiple-application disambiguation |
| `get_application_status` | `get_application_status()` |
| `request_human_agent` | `transfer_to_agent()` |
| `create_callback` | — |

**Ticketing** — there is no `create_ticket()` tool because there need not be: every call
opens a `UccTicket` at call start, and escalation moves it through a guarded state machine.
This satisfies the ticketing requirement natively. ServiceNow is not needed (§14).

**Identity / verification** — `services/identity/` (the authorization gate) and
`services/verification/` (salted-hash OTP sessions with expiry, attempt limits and call
binding). Demo passcode, labelled as such.

**Application APIs** — `services/applications/`, the sole authority for transactional
student data. Multi-application disambiguation is a first-class case.

**Voice bridge** — `apps/ucc-api/src/routes/voice-bridge.ts` already exposes exactly the two
endpoints an external pipeline needs: `GET /api/ai/tools` and `POST /api/calls/:id/tool`.
The Pipecat service consumes both. The catalogue is fetched, never copied, so it cannot
drift.

---

## 6. Spec Kit commands available

Installed as project skills in `.claude/skills/`:

`speckit-constitution` · `speckit-specify` · `speckit-clarify` · `speckit-plan` ·
`speckit-checklist` · `speckit-tasks` · `speckit-analyze` · `speckit-implement` ·
`speckit-converge` · `speckit-taskstoissues`

The full lifecycle the brief asks for is available. Templates and a workflow registry exist
under `.specify/`.

**Gate problem:** the existing constitution (v1.0.0) and `spec.md` are written for
**Amazon Connect + Bedrock**. The code has since pivoted to **Twilio**, and the spec never
followed. Per §28, that inconsistency must be fixed in the specification before
implementation — not coded around.

---

## 7. Beads commands available

`bd` v1.0.2, workspace initialized, 73 issues: **48 closed, 25 open, 24 ready, 1 blocked.**
Existing epics cover Knowledge Base, Identity / Verification, Application APIs, Ticketing,
Routing, Inbound, Agent Experience, Security, Testing and AWS Infrastructure.

Two operational notes:

- `bd dolt push` currently **fails**: `fatal: '$GIT_DIR' too big`. Beads changes commit
  locally but do not reach the Dolt remote. Fix before session close.
- The open epics are Connect-era. They need re-pointing at the Twilio + Pipecat boundary
  rather than being closed or duplicated.

---

## 8. Pipecat Claude Code skills

The `pipecat-ai/skills` marketplace was **not** installed; I added it this session. It
publishes three plugins:

| Plugin | Skill | Usefulness here |
|---|---|---|
| `pipecat` | `/pipecat:init` | **Low.** Scaffolds a *new* project via `pipecat init`. This is brownfield — the service already exists. |
| `pipecat-cloud` | `/pipecat-cloud:deploy` | **Deferred.** Pipecat Cloud deployment; §22 says local first. |
| `pipecat-mcp-server` | `/talk` | **Not applicable.** Voice-driving Claude itself, unrelated to the product. |

Honest assessment: the official Pipecat skills do not carry us far on a brownfield service.
They are scaffolding and deployment helpers. Correct Pipecat *API* usage will come from the
installed package and its documentation, not from these skills. The `pipecat` CLI is not
installed (`uv tool install pipecat-ai-cli` would add it) and is only needed for
`init` / `deploy`.

---

## 9. Verified state of `services/voice-pipecat/`

Established this session by installing the pinned dependencies into a Python 3.12
virtualenv (`uv venv` + `uv pip install -r requirements.txt`, exit 0):

- **`bot.py` does not import under the pinned `pipecat-ai==1.0.0`.** Three of its six
  Pipecat imports point at a pre-1.0 module layout:

  | Import in `bot.py` | Status in 1.0.0 |
  |---|---|
  | `pipecat.processors.aggregators.openai_llm_context` | **missing** — now `...aggregators.llm_context` (`LLMContext`) |
  | `pipecat.transports.network.fastapi_websocket` | **missing** — now `pipecat.transports.websocket.fastapi` |
  | `pipecat.services.aws_nova_sonic.aws` | **missing** — now `pipecat.services.aws.nova_sonic.llm` |
  | `pipecat.serializers.twilio` | ok |
  | `pipecat.audio.vad.silero` | ok |
  | `pipecat.adapters.schemas.function_schema` | ok |

- **`requirements.txt` declares an extra that does not exist:** `pipecat-ai[...twilio...]`
  emits `warning: The package pipecat-ai==1.0.0 does not have an extra named twilio`. The
  Twilio serializer ships in core.
- `AWSNovaSonicLLMService` **does** exist in 1.0.0, at
  `pipecat.services.aws.nova_sonic.llm`. So this is a module-path migration, not a rewrite.
- Discrete STT / LLM / TTS vendors are all present in 1.0.0 — `deepgram`, `cartesia`,
  `elevenlabs`, `anthropic`, `openai`, `aws` (`stt.py` / `tts.py`) among ~40 others — so
  either architecture in R1 is buildable on the pinned version.
- There are **no Python tests** and no CI for this service.

---

## 10. Proposed POC boundary

**Reuse unchanged** — the control plane, KB, tool catalogue, authorization gate, ticketing,
routing, agent workspace, observability, the Twilio webhook layer and the voice bridge.
None of it is rewritten.

**In scope:**

1. Make `services/voice-pipecat/` actually run — fix imports, install, start, health-check.
2. Resolve the R1 architecture conflict, then implement the chosen pipeline.
3. Prove the pipeline locally, then over a real Twilio call.
4. Extend observability to the voice leg: per-stage latency, session lifecycle, tool timing.
5. Add Python-side tests — none exist today; the whole service is untested.
6. Provider-swap seam so STT / LLM / TTS can each be replaced by configuration (§9).
7. Authenticate the voice bridge (R4).
8. Converge the spec, the constitution and Beads onto the Twilio + Pipecat reality.

**Explicitly out of scope** (§27): supervisor dashboard work, department management,
ServiceNow, multi-region, new AWS infrastructure, frontend work, Amazon Connect.

---

## 11. Risks and unknowns

| # | Risk | Assessment |
|---|---|---|
| R1 | **Spec conflict: speech-to-speech vs STT -> LLM -> TTS.** The brief (§5, §9) asks for a discrete pipeline with each stage independently swappable. `bot.py` uses Nova Sonic, which collapses all three into one model. One pipeline cannot satisfy both. | **Blocks a plan decision.** Resolve in `speckit-clarify`, not in code. |
| R2 | **`bot.py` has never been executed** and does not import under its own pinned dependency. No virtualenv, no Python tests, no CI. | **Confirmed, high** — see §9. |
| R3 | **No live-call evidence in the repo.** ConversationRelay is committed and tested, but no artifact records a completed PSTN call; `api.log` shows only UI polling. | **Medium.** Needs confirmation of what has actually been dialled. |
| R4 | **The voice bridge is unauthenticated.** `POST /api/calls/:id/tool` executes privileged tools and is documented as carrying the POC-wide missing-authentication gap. Moving inference out of process makes this an *inter-service* boundary, raising its severity. | **High for the Pipecat path.** Needs a service credential plus call-id session binding. |
| R5 | **Long-lived stateful streams.** Any Pipecat pipeline needs a sticky bidirectional stream per call — no Lambda, capacity planned on concurrent streams, connection draining on deploy. | **Medium — architectural, already priced** in `nova-sonic-assessment.md`. |
| R6 | **ngrok free tier rotates the tunnel URL**, so `PUBLIC_BASE_URL` and the number's webhook must be re-pointed on every restart. With Pipecat there are now **two** ports to tunnel (4000 and 8100). | **Low, but a constant time tax.** |
| R7 | **Production Vapi numbers share the Twilio account.** A misconfigured webhook could disturb live traffic. | **High impact, low likelihood.** Only touch the dedicated POC number. |
| R8 | **`bd dolt push` is failing** (`$GIT_DIR too big`). Issue-tracker state is not reaching the remote. | **Medium.** Fix before session close. |
| R9 | **Nova Sonic invents its own verification process** when refused — it asked for name, DOB and email rather than using the OTP flow. No data leaked and the gate held. | **Low security / medium UX.** Fix in the tool's refusal text, as the Converse path already does. |
| R10 | **Windows, with Python 3.14 as the default interpreter.** Pipecat's native dependencies are happier on 3.12; the venv is pinned accordingly. | **Low** — resolved by pinning. |
