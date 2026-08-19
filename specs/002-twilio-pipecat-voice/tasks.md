---

description: "Task list for 002-twilio-pipecat-voice"
---

# Tasks: UCC Voice AI over Twilio + Pipecat

**Input**: Design documents from `/specs/002-twilio-pipecat-voice/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Included. FR-043 requires automated tests for the voice service (none exist today) and FR-044 requires real-call validation.

**Organization**: Grouped by user story. Each story is independently testable via its quickstart scenario.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Path Conventions

Brownfield monorepo. Voice service: `services/voice-pipecat/`. UCC API: `apps/ucc-api/src/`.
TypeScript tests: `tests/`. Python tests: `services/voice-pipecat/tests/`.

---

## ⚠️ Execution order differs from story priority — read this first

US6 (bridge authentication, P2) is scheduled **before** US2 (protected data, P1).

Priority answers "what matters most"; this ordering answers "what is safe to do next". Once
real protected student data flows over the voice leg, the unauthenticated tool-execution
channel stops being a documented gap and becomes a live exposure reachable through a public
tunnel. US6 is therefore a prerequisite of US2, not a lower-priority successor.

US5 (observability, P2) is likewise scheduled before US4 (topology comparison, P2), because
a comparison cannot be produced without the measurements US5 provides.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Make the voice service installable and runnable at all. Nothing below works until this passes.

- [ ] T001 Correct the dependency extras in `services/voice-pipecat/requirements.txt` to `pipecat-ai[aws,aws-nova-sonic,silero,webrtc]==1.0.0`, removing the non-existent `twilio` extra and adding `aws-nova-sonic` (research §R2)
- [ ] T002 Add `services/voice-pipecat/pytest.ini` with test discovery under `tests/` and asyncio mode enabled
- [ ] T003 [P] Add `services/voice-pipecat/.python-version` pinning 3.12 and document the floor in `services/voice-pipecat/README.md` (the Nova Sonic dependency is gated on `python_version >= "3.12"`)
- [ ] T004 [P] Extend `.gitignore` coverage and `.env.example` with the new voice keys (`UCC_PIPELINE_MODE`, `UCC_VOICE_SERVICE_TOKEN`, `UCC_STT_PROVIDER`, `UCC_LLM_PROVIDER`, `UCC_TTS_PROVIDER`, `NOVA_SONIC_MODEL_ID`) documenting shape only, never values

**Checkpoint**: `uv pip install -r requirements.txt` completes with no unknown-extra warning.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Migrate to the Pipecat 1.0.0 API and decompose `bot.py` so the pipeline can be built and tested without a websocket.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete — today `import bot` fails.

- [ ] T005 Create `services/voice-pipecat/config.py` defining the `PipelineConfig` schema from data-model §3, reading from the environment, with fail-fast validation and no silent fallback (FR-026, FR-030)
- [ ] T006 Create `services/voice-pipecat/observability.py` with a structured JSON logger that stamps `uccCallId` on every line and applies the redaction rules in data-model §Redaction (FR-033, FR-037, FR-038)
- [ ] T007 [P] Create `services/voice-pipecat/prompts/assistant.md` as the single versioned prompt artifact, moving the prompt text out of `bot.py`
- [ ] T008 [P] Create `services/voice-pipecat/prompt.py` to load `prompts/assistant.md` and expose it both as a context message and as a system-instruction string, so both topologies use identical text (research §R4)
- [ ] T009 Create `services/voice-pipecat/tools.py` with the catalogue-to-`FunctionSchema` conversion and the tool handler factory, moved out of `bot.py` (FR-024)
- [ ] T010 Migrate `services/voice-pipecat/bot.py` to the 1.0.0 module layout: `LLMContext`, `pipecat.transports.websocket.fastapi`, `LLMContextAggregatorPair` in place of the removed `create_context_aggregator`, and `TwilioFrameSerializer.InputParams(auto_hang_up=False)` (research §R1)
- [ ] T011 Reduce `services/voice-pipecat/bot.py` to the FastAPI app, the `/health` endpoint reporting mode and model, and the websocket session lifecycle
- [ ] T012 [P] Write `services/voice-pipecat/tests/test_config.py` covering fail-fast on missing token, unknown provider and invalid mode (FR-026, FR-030)
- [ ] T013 [P] Write `services/voice-pipecat/tests/test_tools.py` covering catalogue-to-schema conversion and handler construction

**Checkpoint**: `python -c "import bot"` succeeds; `uvicorn bot:app` starts; `/health` responds; `pytest` passes.

---

## Phase 3: User Story 1 — A caller gets a useful answer by phone (Priority: P1) 🎯 MVP

**Goal**: A real caller dials the number and gets an accurate answer to a public question, can interrupt, and hangs up leaving a complete case.

**Independent test**: Quickstart V3.

- [ ] T014 [US1] Create `services/voice-pipecat/pipeline.py` exposing `build_processors(mode, services)` returning the ordered processor list, with the cascaded branch implemented (FR-020, FR-023)
- [ ] T015 [US1] Wire the cascaded services in `services/voice-pipecat/pipeline.py`: `AWSTranscribeSTTService`, `AWSBedrockLLMService`, `AWSPollyTTSService`, selected by provider config (FR-022)
- [ ] T016 [US1] Assemble transport, serializer, VAD and `PipelineTask` in `services/voice-pipecat/bot.py` with `audio_in_sample_rate=8000` and interruptions enabled (FR-003)
- [ ] T017 [US1] Implement session binding in `services/voice-pipecat/bot.py`: read `uccCallId`, `tenantId`, `sessionToken` from the stream `start` frame and refuse the session if any is absent (FR-006, contract stream-parameters)
- [ ] T018 [US1] Add the fixed greeting to the TwiML in `apps/ucc-api/src/routes/twilio.ts` as a `<Say>` preceding `<Connect>` on the pipecat branch, so no opening utterance is lost (FR-001, SC-001)
- [ ] T019 [US1] Implement session close handling in `services/voice-pipecat/bot.py`, ending the UCC call with `COMPLETED` on caller hang-up and never on escalation (FR-005)
- [ ] T020 [US1] Implement the empty-retrieval response path in `services/voice-pipecat/prompts/assistant.md`, ensuring a no-results knowledge lookup is relayed as a plain admission plus an offer of a human, distinct from a tool denial (FR-008)
- [ ] T021 [US1] Refuse the session when the tool catalogue cannot be fetched at session start, in `services/voice-pipecat/bot.py` (FR-046)
- [ ] T022 [US1] Speak a brief explanation and end the call deliberately when a session is refused, via the TwiML fallback in `apps/ucc-api/src/routes/twilio.ts` (FR-048)
- [ ] T023 [P] [US1] Write `services/voice-pipecat/tests/test_session.py` covering binding, refusal without ids, and close-reason selection
- [ ] T024 [P] [US1] Write `services/voice-pipecat/tests/test_pipeline.py` asserting the cascaded processor list is built in the expected order
- [ ] T025 [P] [US1] Write `tests/integration/pipecat-twiml.test.ts` asserting the TwiML emits the greeting before `<Connect>`, carries all three stream parameters, and still rejects an unsigned webhook (FR-032)
- [ ] T026 [US1] Validate on a real phone call per `specs/002-twilio-pipecat-voice/quickstart.md` V3, recording the outcome as executed evidence (FR-044, FR-045)

**Checkpoint**: A real call answers a public question, supports interruption, and leaves a complete case. **This is the MVP.**

---

## Phase 4: User Story 6 — The privileged channel is closed (Priority: P2, sequenced early)

**Goal**: Only the voice pipeline can execute tools, and only for the call it is serving.

**Independent test**: Quickstart V2.

- [ ] T027 [US6] Add the voice service credential and session-token settings to the config schema in `packages/config/src/index.ts`, required rather than optional (FR-030)
- [ ] T028 [US6] Implement `CallSessionToken` issue and verify per data-model §2, in `services/verification/src/` or a sibling module, stored in the existing tenant-partitioned store with expiry (FR-028, FR-029)
- [ ] T029 [US6] Mint a session token when generating the pipecat TwiML in `apps/ucc-api/src/routes/twilio.ts` and attach it as a `<Stream>` parameter (contract stream-parameters)
- [ ] T030 [US6] Enforce the service credential on both endpoints in `apps/ucc-api/src/routes/voice-bridge.ts`, returning `401` when missing or invalid (FR-027)
- [ ] T031 [US6] Enforce session-token binding on `POST /api/calls/:id/tool` in `apps/ucc-api/src/routes/voice-bridge.ts`, returning `403` when the token names a different case, has expired, or its call has ended (FR-028, FR-029)
- [ ] T032 [US6] Send both credentials from `services/voice-pipecat/ucc_client.py` and refuse to start without the service credential (FR-030)
- [ ] T033 [US6] Set the per-call token lifetime to exceed the maximum supported call duration, and refuse plus escalate on mid-call expiry, in `services/verification/src/` and `services/voice-pipecat/ucc_client.py` (FR-047)
- [ ] T034 [US6] Verify the service credential against UCC at voice-service startup, in `services/voice-pipecat/bot.py`, so a mismatch fails immediately rather than on the first caller's first tool call (FR-050)
- [ ] T035 [P] [US6] Write `tests/unit/voice-bridge-auth.test.ts` covering missing credential, wrong credential, missing token, cross-case token, and expired token
- [ ] T036 [P] [US6] Write `services/voice-pipecat/tests/test_ucc_client.py` covering header construction, the explicit failure shape on non-2xx, and timeout behaviour (FR-039)
- [ ] T037 [US6] Record the token-transits-Twilio threat and its blast radius in `docs/security.md` (research §R6)

**Checkpoint**: Quickstart V2 passes. Protected data may now safely flow over the voice leg.

---

## Phase 5: User Story 2 — Protected student data is gated on the phone (Priority: P1)

**Goal**: Verification is required before any protected disclosure, and asserting verification changes nothing.

**Independent test**: Quickstart V4.

- [ ] T038 [US2] Verify the verification and application tools resolve correctly through the voice tool handler in `services/voice-pipecat/tools.py`, relaying denials verbatim (FR-010, FR-012)
- [ ] T039 [US2] Ensure denial messages returned by `services/ai/src/tools.ts` state the real passcode remediation explicitly, so the model has no gap to fill with an invented procedure (FR-010, US2 scenario 6)
- [ ] T040 [US2] Confirm multi-application disambiguation behaves over voice, adjusting only `services/voice-pipecat/prompts/assistant.md` if the model guesses (FR-013)
- [ ] T041 [P] [US2] Extend `tests/security/security.test.ts` with a voice-path case asserting an asserted-verification claim does not flip server-side state (FR-012)
- [ ] T042 [US2] Define the scripted security corpus of at least 10 calls in `scripts/voice-security-corpus.md`, distinct from the latency corpus (SC-006, SC-007, SC-009)
- [ ] T043 [US2] Validate on a real phone call per `specs/002-twilio-pipecat-voice/quickstart.md` V4, including the wrong-passcode and assertion-of-verification paths (FR-044)

**Checkpoint**: Protected data is disclosed only after real verification, on a real call.

---

## Phase 6: User Story 3 — A caller who asks for a person actually reaches one (Priority: P1)

**Goal**: Escalation transfers the caller to a human, and the assistant stops talking.

**Independent test**: Quickstart V5. Judged by what the caller hears, not by ticket state.

- [ ] T044 [US3] Handle the `escalated` control signal in `services/voice-pipecat/bot.py` by ending the pipeline without ending the UCC call, leaving the transfer to the TwiML action URL (FR-016, contract stream-parameters)
- [ ] T045 [US3] Ensure the assistant stops speaking before the session closes on escalation in `services/voice-pipecat/bot.py`, so no audio continues after handoff begins (FR-016)
- [ ] T046 [US3] Confirm the existing handoff path in `apps/ucc-api/src/routes/twilio.ts` behaves identically for the pipecat branch, covering both `UCC_ROUTING` modes
- [ ] T047 [US3] Capture the voice leg conversation into the existing transcript, in `services/voice-pipecat/bot.py` and `services/recording/src/`, so an escalated case reaches the agent with its AI segment present (FR-049)
- [ ] T048 [P] [US3] Add protocol tests in `tests/unit/` pinning the escalation close sequence, so the `end_session` class of regression cannot recur silently
- [ ] T049 [US3] Validate on a real phone call per `specs/002-twilio-pipecat-voice/quickstart.md` V5 with an agent answering in the workspace, confirming from the caller's ear (FR-044, SC-008)

**Checkpoint**: The scenario that failed on the first live call now demonstrably works.

---

## Phase 7: User Story 5 — An engineer can see what happened on a call (Priority: P2)

**Goal**: Any call is fully reconstructable, with per-stage latency.

**Independent test**: Quickstart V7 log inspection and V9.

- [ ] T050 [US5] Enable `PipelineParams(enable_metrics=True)` and attach `UserBotLatencyObserver` and `TurnTrackingObserver` to the `PipelineTask` in `services/voice-pipecat/bot.py` (research §R5)
- [ ] T051 [US5] Implement a metrics observer in `services/voice-pipecat/observability.py` that maps `TTFBMetricsData` per processor into the `TurnMetrics` shape from data-model §5 (FR-034)
- [ ] T052 [US5] Time tool round trips in the handler in `services/voice-pipecat/tools.py` and log name, outcome and duration (FR-035)
- [ ] T053 [US5] Log session lifecycle transitions — stream open, first audio, escalation, close and close reason — in `services/voice-pipecat/bot.py` (FR-036)
- [ ] T054 [P] [US5] Write `services/voice-pipecat/tests/test_observability.py` asserting redaction of tokens, passcodes and credentials (FR-037)
- [ ] T055 [US5] Verify log hygiene per `specs/002-twilio-pipecat-voice/quickstart.md` V9 across a full test corpus (SC-013)

**Checkpoint**: Latency numbers exist and no secret appears in any log line.

---

## Phase 8: User Story 4 — The two topologies are compared with evidence (Priority: P2)

**Goal**: Both topologies run behind one switch and their latency is published side by side.

**Independent test**: Quickstart V6 and V7.

- [ ] T056 [US4] Implement the speech-to-speech branch in `services/voice-pipecat/pipeline.py` using `AWSNovaSonicLLMService` from `pipecat.services.aws.nova_sonic.llm`, sharing the same transport, serializer and tool bridge (FR-020, FR-023)
- [ ] T057 [US4] Pass the prompt as `system_instruction=` for the speech-to-speech branch while the cascaded branch injects it as a context message, from the one artifact (research §R4)
- [ ] T058 [US4] Validate at startup that the configured Nova Sonic model is `nova-2-sonic`, failing fast rather than discovering on the first call that no tool is ever requested (research §R2)
- [ ] T059 [P] [US4] Extend `services/voice-pipecat/tests/test_pipeline.py` asserting both modes build, that transport, serializer and tool bridge instances are shared rather than merely equivalent, and that neither branch holds tool logic, authorization or persistence (FR-023, FR-025, SC-010)
- [ ] T060 [US4] Create `scripts/voice-latency-run.md` defining the fixed latency corpus, sample size and reporting format before any results exist, distinct from the security corpus (SC-011, spec §Assumptions)
- [ ] T061 [US4] Execute the comparison per `specs/002-twilio-pipecat-voice/quickstart.md` V6 and V7, five calls per topology on the same number
- [ ] T062 [US4] Write `docs/voice-topology-comparison.md` reporting median and worst per stage, how the numbers were obtained, and what would invalidate them (SC-011, constitution §IX)

**Checkpoint**: The Principle XI question is answered with data rather than preference.

---

## Phase 9: User Story 7 — Failures degrade safely (Priority: P3)

**Goal**: Every failure produces a truthful sentence and a route forward.

**Independent test**: Quickstart V8.

- [ ] T063 [US7] Apply bounded timeouts to every UCC and provider call in `services/voice-pipecat/ucc_client.py` and `services/voice-pipecat/pipeline.py` (FR-039)
- [ ] T064 [US7] Implement safe caller-facing failure responses in `services/voice-pipecat/bot.py`, containing no technical detail, with the structured detail logged instead (FR-040)
- [ ] T065 [US7] Ensure a dependency failure escalates rather than dropping the call silently, in `services/voice-pipecat/bot.py` (FR-041)
- [ ] T066 [P] [US7] Write `services/voice-pipecat/tests/test_failures.py` covering UCC unreachable, tool timeout and malformed response
- [ ] T067 [US7] Execute the fault-injection matrix per `specs/002-twilio-pipecat-voice/quickstart.md` V8 on live calls (SC-015)

**Checkpoint**: Every simulated failure is heard by the caller as a calm, truthful sentence.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [ ] T068 [P] Write `docs/adr/0007-two-pipeline-topologies.md` recording why both topologies exist and what the measurement showed
- [ ] T069 [P] Write `docs/adr/0008-voice-bridge-authentication.md` recording the layered credential decision and the rejected alternatives (research §R6)
- [ ] T070 [P] Write `docs/local-development.md` covering the two-tunnel setup, re-pointing procedure and the troubleshooting table from quickstart
- [ ] T071 [P] Update `README.md` so the capability table distinguishes executed from implemented, per constitution Principle VII (FR-045)
- [ ] T072 [P] Update `docs/architecture.md` and `docs/call-flow.md` with the Pipecat voice leg and the two topologies
- [ ] T073 Run the full suite — `npx vitest run` and `pytest` — and record results in `docs/testing.md` (FR-043)
- [ ] T074 [P] Verify the voice service tests pass from a clean checkout following only the documented setup steps in `specs/002-twilio-pipecat-voice/quickstart.md` (SC-016)
- [ ] T075 Review `git diff` for accidentally committed secrets, tunnel URLs or `.env` content before completion (constitution §Security Requirements)

---

## Dependencies

```
Phase 1 (Setup)
    ↓
Phase 2 (Foundational — bot.py must import)   ← blocks everything
    ↓
Phase 3 (US1, P1) ────────────────── MVP
    ↓
Phase 4 (US6, P2) ← security prerequisite, not a successor
    ↓
Phase 5 (US2, P1) ── protected data may now flow
    ↓
Phase 6 (US3, P1)
    ↓
Phase 7 (US5, P2) ← measurement must exist before comparison
    ↓
Phase 8 (US4, P2)
    ↓
Phase 9 (US7, P3)
    ↓
Phase 10 (Polish)
```

**Story independence**: US1, US2, US3 and US7 are independently demonstrable once Phase 2
completes. US4 depends on US5 for its numbers. US2 depends on US6 for safety rather than for
function — US2 would *work* without US6, which is precisely why the ordering is stated
explicitly rather than left to judgement.

---

## Parallel Execution Opportunities

| Phase | Parallelisable |
|---|---|
| 1 | T003, T004 |
| 2 | T007 + T008 (prompt) alongside T005/T006; T012 + T013 once their subjects exist |
| 3 | T023, T024, T025 — three different test files, no shared state |
| 4 | T035 (TypeScript) and T036 (Python) — different runtimes entirely |
| 7 | T054 alongside T050–T053 |
| 10 | T068–T072 — five independent documents |

Real-call validation tasks (T026, T043, T049, T061, T067) are inherently serial: one phone,
one number, one caller.

---

## Implementation Strategy

**MVP is Phase 1 → Phase 3.** That delivers a real caller getting a real answer from the real
knowledge base over a real phone call — the whole premise of the POC, provable in one dial.

**Then stop and reassess.** If the cascaded topology's latency is unacceptable at that point,
Phase 8 becomes more valuable than Phase 5 and the order should change. The plan says
measure before optimising; the tasks are ordered on that assumption, not on certainty.

**Do not skip Phase 4.** It is the only phase whose omission would make the system less safe
than not building the feature at all.
