# Implementation Plan: UCC Voice AI over Twilio + Pipecat

**Feature**: `002-twilio-pipecat-voice` | **Date**: 2026-08-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-twilio-pipecat-voice/spec.md`

**Constitution**: `.specify/memory/constitution.md` v2.0.0

---

## Summary

Make the existing Pipecat voice service actually work, give it two interchangeable pipeline
topologies, close the privileged channel it uses to reach UCC, instrument it, test it, and
prove it on a real phone call.

The technical approach follows from Phase 0 research: the service's design is sound but it
was written against a pre-1.0 Pipecat API and has never been executed. Rather than rewriting
it, migrate it to the 1.0.0 surface, then factor the pipeline construction behind a small
factory so `cascaded` and `s2s` differ only in the ordered list of processors. Everything
around that list — transport, serializer, session binding, tool bridge, authorization gate —
is shared by construction, which is what makes the two topologies comparable rather than
merely coexistent.

Nothing above the media stream changes. UCC keeps every business decision.

---

## Technical Context

**Language/Version**: Python 3.12 (voice service) · TypeScript 5.7 / Node 20+ (UCC API)

**Primary Dependencies**: `pipecat-ai[aws,aws-nova-sonic,silero,webrtc]==1.0.0`, FastAPI,
uvicorn, httpx (voice service) · Fastify 5, `twilio` 6, zod (UCC API)

**Storage**: No new persistent entities. One short-lived `CallSessionToken` record in the
existing tenant-partitioned store. Everything else already exists.

**Testing**: `pytest` for the voice service (new — none exists today) · `vitest` for the UCC
API (existing, 115 tests passing)

**Target Platform**: Local development on Windows, two ports exposed via HTTPS/WSS tunnel.
No cloud deployment in this feature.

**Project Type**: Brownfield modular monolith plus one out-of-process real-time service.

**Performance Goals**: s2s ≤1 s and cascaded ≤2.5 s to first audio after the caller stops
speaking; interrupt-to-silence ≤500 ms; tool round trip adding ≤1.5 s (SC-002..SC-005).

**Constraints**: Twilio Media Streams is 8 kHz μ-law. Long-lived stateful stream per call —
no serverless. Nova Sonic requires `nova-2-sonic`; v1 does not emit tool requests. Amazon
Transcribe accepts only 8 kHz or 16 kHz. Two tunnels required in development. Only the
dedicated POC number may be touched.

**Scale/Scope**: One concurrent call for validation; a handful for smoke. Capacity planning
is explicitly out of scope and documented as a production concern.

---

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1 design. Both passes below.*

| Principle | Gate | Pre-design | Post-design |
|---|---|---|---|
| **I** — Platform / Pipecat / UCC ownership | No business logic in the pipeline; no telephony reimplemented in UCC | PASS | PASS — pipeline holds transport, VAD, turn-taking only |
| **II** — Every call is a case | Case opened at call start, before conversation | PASS | PASS — unchanged; TwiML layer already does this |
| **III** — Authorization server-side | Gate reads persisted state, not the conversation | PASS | PASS — pipeline calls the same executor as the text path |
| **IV** — Never fabricate | Retrieval failure escalates; refusals state real remediation | PASS | PASS — contract mandates explicit failure objects, never empty results |
| **V** — Traceable | Correlation id on every line; per-stage latency | PASS | PASS — `TurnMetrics` + refuse-without-case-id rule |
| **VI** — Idempotent events | Duplicate provider events are no-ops | PASS | PASS — unchanged; enforced at the persistence layer |
| **VII** — Do not fake | Nothing described as working until executed | **FAIL (pre-existing)** | PASS — this feature exists partly to fix that violation |
| **VIII** — Credible production path | Simplifications documented in ADRs | PASS | PASS — stateful-stream cost recorded; new ADRs listed below |
| **IX** — Evidence over advocacy | Measurement method and invalidation stated | PASS | PASS — V7 defines the method before results exist |
| **X** — Pipeline carries no policy | No tool logic, no schema copy, authenticated channel | **FAIL (pre-existing)** | PASS — bridge gains service credential + per-call binding |
| **XI** — Provider choice is configuration | Both topologies behind one switch, measured | **FAIL (pre-existing)** | PASS — factory + `UCC_PIPELINE_MODE`, compared in V7 |

**Three pre-existing violations, all closed by this feature.** They are recorded as FAIL
rather than N/A because the repository is in that state today: a voice service documented as
a capability that had never been run (VII), an unauthenticated privileged channel (X), and a
single hard-wired topology (XI).

**No unjustified violations remain.** See Complexity Tracking for two accepted tensions.

---

## Project Structure

### Documentation (this feature)

```text
specs/002-twilio-pipecat-voice/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 — executed findings
├── data-model.md        # Phase 1 — session, token, config, metrics
├── quickstart.md        # Phase 1 — run and validate
├── contracts/
│   ├── voice-bridge-api.md      # UCC ↔ pipeline HTTP contract
│   └── stream-parameters.md     # TwiML ↔ Twilio ↔ pipeline handshake
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 — created by /speckit-tasks
```

### Source Code (repository root)

```text
services/voice-pipecat/           # MODIFIED — the bulk of the work
├── bot.py                        # slimmed to FastAPI app + session lifecycle
├── config.py                     # NEW — env schema, mode/provider selection, fail-fast
├── pipeline.py                   # NEW — factory returning the processor list per mode
├── prompt.py                     # NEW — loads the versioned prompt artifact
├── tools.py                      # NEW — catalogue → FunctionSchema, handler factory
├── ucc_client.py                 # MODIFIED — auth headers, timeouts, tool timing
├── observability.py              # NEW — structured logging + metrics observer
├── prompts/
│   └── assistant.md              # NEW — versioned prompt, one artifact for both modes
├── requirements.txt              # MODIFIED — corrected extras
├── pytest.ini                    # NEW
└── tests/                        # NEW — none exist today
    ├── test_tools.py             #   schema conversion, handler behaviour
    ├── test_ucc_client.py        #   auth headers, failure shapes, timeouts
    ├── test_config.py            #   fail-fast on bad/missing configuration
    ├── test_session.py           #   binding rules, refusal without ids
    └── test_pipeline.py          #   both modes build; shared components identical

apps/ucc-api/src/routes/
├── voice-bridge.ts               # MODIFIED — service credential + session binding
└── twilio.ts                     # MODIFIED — mint token, add <Say> greeting, stream param

services/verification/src/        # MODIFIED — or a sibling module: session-token issue/verify
packages/config/src/              # MODIFIED — new env keys

tests/
├── unit/voice-bridge-auth.test.ts    # NEW
└── integration/pipecat-twiml.test.ts # NEW — TwiML shape, greeting order, parameters

docs/
├── adr/0007-two-pipeline-topologies.md   # NEW
├── adr/0008-voice-bridge-authentication.md # NEW
├── security.md                            # MODIFIED — token threat model
└── local-development.md                   # NEW — two-tunnel setup
```

**Structure Decision**: The voice service stays a single out-of-process Python service under
`services/voice-pipecat/`, matching the existing repository convention where `services/*` are
domain modules. It is the only non-TypeScript module and the only one that is not composed
into the Fastify container, because it cannot be — it owns long-lived streams. `bot.py` is
decomposed into focused modules rather than growing, so that the pipeline factory can be
unit-tested without a websocket and the config can be validated without AWS.

---

## Implementation phases

Ordered so each phase leaves the repository in a better state than it found it, and so the
riskiest unknown is retired first.

| Phase | Goal | Exit criterion | tasks.md |
|---|---|---|---|
| **A. Make it run** | Migrate to the 1.0.0 API, fix `requirements.txt`, decompose `bot.py`, add config with fail-fast | `import bot` succeeds; service starts; `/health` reports mode | Phases 1–2 |
| **B. Cascaded pipeline** | Transcribe → Bedrock → Polly behind the factory, tools wired through the bridge | A real call answers a public question (V3) | Phase 3 (US1) |
| **C. Close the bridge** | Service credential, per-call token, minting in TwiML, binding checks | V2 passes; unauthenticated and cross-case calls rejected | Phase 4 (US6) |
| **D. Protected data + escalation** | Verification and transfer over the voice leg | V4 and V5 pass on a real call | Phases 5–6 (US2, US3) |
| **E. Observability** | Metrics, observers, structured logging, redaction | V7 produces numbers; V9 is silent | Phase 7 (US5) |
| **F. Speech-to-speech + comparison** | Nova Sonic behind the same factory, then measure both | V6 passes with one config change and no code edit | Phase 8 (US4) |
| **G. Tests and docs** | pytest suite, TS bridge tests, ADRs, local-dev guide | V1 passes; report distinguishes executed from implemented | Phases 9–10 (US7, Polish) |

Two orderings here are deliberate and neither follows story priority.

**C precedes D.** Once protected data flows over the voice leg, an open privileged channel
stops being a documented gap and becomes a live exposure.

**E precedes F.** Speech-to-speech is the more exciting phase and the temptation is to reach
for it first, but its whole justification is a latency comparison — and a comparison cannot
be produced before the instrumentation that measures it exists. Building F first would mean
either measuring it twice or reporting an impression instead of a number, which Principle IX
forbids.

---

## Key design decisions

**One prompt artifact, two delivery mechanisms.** `prompts/assistant.md` is the single
source. The cascaded path injects it as a context message; Nova Sonic takes it as
`system_instruction=`. If the two modes ran different prompt text, the Phase-F comparison
would be measuring the prompt, not the pipeline.

**The factory returns a list, not a pipeline.** `build_processors(mode, services)` returns
the ordered processors; the caller assembles `Pipeline`, `PipelineTask` and observers
identically for both modes. This is what makes "same transport, same serializer, same tool
bridge" (FR-023) structurally true rather than a claim in a comment.

**Configuration fails fast and never falls back.** A bad provider name or a missing token
stops the service at startup. Silent fallback is how you end up measuring the wrong topology
and reporting it as the right one.

**Tool results are relayed verbatim, including denials.** A denial is data the model must
speak, not an error to smooth over. The contract mandates an explicit failure object on
transport errors so the model is never handed an empty result to fill in.

**Escalation does not end the UCC call from the pipeline.** The TwiML action URL owns the
transfer. Auto hang-up stays disabled in the serializer. This is the failure mode that has
already cost a live call.

---

## Complexity Tracking

Two accepted tensions. Neither is an unjustified violation, but both cost something and are
recorded so a reviewer can disagree.

| Tension | Why accepted | Simpler alternative rejected because |
|---|---|---|
| Two full pipeline topologies in a POC, against Principle VIII's "do not over-engineer" | Principle XI requires it explicitly: the latency-versus-swappability trade is the question this POC exists to answer, and one topology makes the answer unfalsifiable | Building only s2s would give the best demo and no evidence; building only cascaded would meet the brief's letter and discard a measured 433 ms result already in hand |
| A second language and runtime in a TypeScript monorepo | Pipecat is Python-only, and the alternative is reimplementing real-time transport, VAD, turn-taking and barge-in — precisely what Principle I forbids UCC from owning | A TypeScript media-stream handler would be more code, worse turn-taking, and would put voice orchestration inside the UCC process where it does not belong |

---

## Risks carried into implementation

| Risk | Mitigation | Trigger to revisit |
|---|---|---|
| AWS Transcribe/Polly slower than SC-003 allows | Provider is configuration (FR-022) | Cascaded misses 2.5 s in V7 → swap one stage, re-measure |
| Nova 2 Sonic unavailable or unentitled in the account | Fail at startup, not mid-call | s2s refuses to start → check Bedrock model access before blaming the code |
| Escalation regression recurs | V5 judged by what the caller hears, plus protocol tests | Any V5 run where the assistant speaks after escalating |
| Two rotating tunnel URLs | Documented re-point procedure in quickstart | Calls connecting to silence |
| Session token transits Twilio | Short expiry, case-scope only, recorded in `docs/security.md` | Any move beyond POC |
| Python 3.14 is the host default | Virtualenv pinned to 3.12, checked in quickstart prerequisites | Import failures on a fresh machine |

---

## Out of scope

Amazon Connect · external ticketing · supervisor dashboard changes · new cloud
infrastructure · frontend work · multi-region · production deployment · call recording
capture · multi-language · closing the wider end-user authentication gap across the API
(only the voice bridge is closed here; the rest stays documented in `docs/security.md`).
