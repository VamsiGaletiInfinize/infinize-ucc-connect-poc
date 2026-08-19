# Feature Specification: UCC Voice AI over Twilio + Pipecat

**Feature Branch**: `002-twilio-pipecat-voice`

**Created**: 2026-08-19

**Status**: Draft

**Constitution**: `.specify/memory/constitution.md` v2.0.0

**Input**: User description: "UCC voice AI over Twilio + Pipecat. A caller dials the POC Twilio number, Pipecat answers over a bidirectional media stream, and a voice assistant handles the conversation end to end: greets, answers public questions from the existing UCC knowledge base, requires identity verification before any protected student data, returns application status for a verified caller, disambiguates when a caller holds multiple applications, escalates to a human agent on request or on failure, and refuses to fabricate. Two pipeline topologies must be built behind one configuration switch and measured against each other on the same number: cascaded (STT -> LLM -> TTS, each stage swappable by configuration) and speech-to-speech. Both share one transport, one serializer, one tool bridge and one UCC authorization gate."

---

## Context: what already exists

This is a **brownfield** feature. The following are reused **unchanged** and are not part of
this feature's scope beyond calling them correctly:

| Capability | Where it lives | State |
|---|---|---|
| Tool catalogue (8 tools) served over HTTP | `services/ai` via `GET /api/ai/tools` | Working |
| Server-side authorization gate | `services/identity` + tool executor | Working, live-verified |
| Identity verification (OTP lifecycle) | `services/verification` | Working |
| Public knowledge base + retrieval | `services/knowledge` | Working, live-verified |
| Application APIs (protected data) | `services/applications` | Working |
| Case + ticket lifecycle, event timeline | `services/ticketing`, `services/events` | Working |
| Department routing, queue, agent assignment | `services/routing` | Working |
| Twilio webhooks, TwiML, signature verification, handoff | `apps/ucc-api/src/routes/twilio.ts` | Working |
| Agent softphone (browser) | `routes/agent-voice.ts` + web app | Working |
| Tool execution bridge for an external pipeline | `routes/voice-bridge.ts` | Working, **unauthenticated** |

**Nothing above is rebuilt.** A change to any of it is out of scope unless a requirement
below names it explicitly.

---

## Clarifications

### Session 2026-08-19

- Q: Which speech-to-text and text-to-speech providers should the cascaded pipeline use by
  default? → A: All AWS — Amazon Transcribe (STT), Bedrock Claude (LLM), Amazon Polly (TTS).
  No new vendor accounts, no new credentials, and caller audio stays inside the existing
  account boundary. Verified present in the pinned voice framework as streaming-capable
  services. Latency is expected to be worse than a best-of-breed pairing; because provider
  choice is configuration (FR-022), that is measurable and cheap to revisit.
- Q: How should UCC verify that a tool request really comes from the voice pipeline, and
  really belongs to the call it names? → A: Both, layered. A shared service credential
  proves the pipeline's identity (FR-027); a short-lived token minted by UCC and bound to
  one call id proves the session is entitled to that specific case (FR-028). A shared
  secret alone was rejected because any holder could then read any case by guessing a call
  id — which is the hole Principle X exists to close, reopened one layer down.
- Q: Who should speak the very first words the caller hears — the telephony layer before the
  audio stream connects, or the assistant once connected? → A: The telephony layer speaks a
  fixed greeting from the call-answer instructions while the stream is still being
  established; the assistant then listens rather than opening with its own greeting. This
  removes the roughly one-second dead-air window during stream setup, behaves identically in
  both topologies, and matches what the existing text-based voice path already does. The
  cost is that the greeting is fixed text in a different voice from the assistant's.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A caller gets a useful answer by phone (Priority: P1)

A prospective student dials the university's number. Someone answers immediately, greets
them, and answers their question about admissions accurately, sourced from the university's
published information. The caller can interrupt mid-sentence and be understood. When they
have what they need, the call ends cleanly.

**Why this priority**: This is the whole premise. Without it there is no voice POC, and
every other story is unreachable because they all begin with a connected call.

**Independent Test**: Dial the POC number from a real phone, ask "what documents do I need
to apply?", confirm the answer matches the published corpus, interrupt mid-answer and
confirm the assistant stops and responds to the new input, then hang up and confirm a case
exists with a full timeline.

**Acceptance Scenarios**:

1. **Given** the voice service is running and the number is pointed at it, **When** a caller
   dials, **Then** they hear a greeting on answer with no preceding silence, a case is
   already open, and the assistant is listening by the time the greeting finishes.
2. **Given** a connected call, **When** the caller asks a question covered by the published
   corpus, **Then** the answer is drawn from that corpus and contains no invented specifics.
3. **Given** the assistant is speaking, **When** the caller starts talking over it, **Then**
   the assistant stops speaking and responds to what the caller just said.
4. **Given** a connected call, **When** the caller asks something the corpus does not cover,
   **Then** the assistant says it does not know and offers a human, rather than guessing.
5. **Given** a call in progress, **When** the caller hangs up, **Then** the session closes,
   the case is ended with a reason, and no process is left holding the stream open.

---

### User Story 2 - Protected student data is gated on the phone (Priority: P1)

An applicant calls and asks about their own application. Before anything personal is said
aloud, the assistant requires them to verify their identity. Only after they verify does it
disclose their status. If they cannot verify, they learn nothing about the record.

**Why this priority**: This is the constitution's central security property (Principle III),
and the whole point of moving inference out of process is to prove that the property does not
move with it (Principle X). A voice POC that discloses protected data is a failed POC, not a
partially successful one.

**Independent Test**: Call and ask for application status without verifying — confirm
refusal and confirm the server-side verification flag never flips. Then verify with the
passcode and confirm the same question is answered from the authoritative record.

**Acceptance Scenarios**:

1. **Given** an unverified caller, **When** they ask for their application status, **Then**
   no status, programme, decision or fee value is spoken, and the assistant explains that
   verification is needed and how it works.
2. **Given** an unverified caller, **When** they assert they have already been verified —
   by a colleague, on a previous call, or in any other way — **Then** the assertion changes
   nothing and the refusal stands.
3. **Given** a caller who has been sent a passcode, **When** they read back the correct
   passcode, **Then** verification succeeds and the protected record becomes available.
4. **Given** a caller who reads back a wrong, expired, or reused passcode, **When** they
   retry beyond the permitted number of attempts, **Then** verification fails and protected
   data remains undisclosed.
5. **Given** a verified caller who holds more than one application, **When** they ask about
   "my application", **Then** the assistant asks which one and does not pick for them.
6. **Given** a refused caller, **When** the assistant explains what to do next, **Then** it
   describes the real passcode procedure and does not invent an alternative identity check.

---

### User Story 3 - A caller who asks for a person actually reaches one (Priority: P1)

A caller says they would rather speak to someone. The assistant acknowledges, stops talking,
and the call is handed to a human agent — who answers with the case, the conversation
summary and the verification status already on screen.

**Why this priority**: P1 because it is both a headline capability and the one that has
already failed in production conditions. On the first live call the assistant escalated
correctly and the task queued correctly, but the session never closed and the caller waited
two minutes hearing reassurances. The fix is committed but has never been re-tested on a
real call.

**Independent Test**: Call, ask for a human, and confirm from the caller's own ear that the
line transfers and a person can speak to them — not merely that the case moved to
`ESCALATED` in the database.

**Acceptance Scenarios**:

1. **Given** a call in progress, **When** the caller asks for a human, **Then** the
   assistant stops speaking and the caller is placed in the transfer path within seconds.
2. **Given** an escalation, **When** the handoff occurs, **Then** the case carries the
   department, the reason and the conversation so far, and the agent sees them on answering.
3. **Given** an escalation, **When** no agent is available, **Then** the caller is told the
   truth and a callback is recorded — the caller is never left on an open, silent line.
4. **Given** an escalation, **When** the transfer path fails for any reason, **Then** the
   caller is told plainly and the case stays open rather than being closed as resolved.
5. **Given** any escalation, **When** the session ends, **Then** the voice session is
   actually closed and the assistant does not continue speaking afterwards.

---

### User Story 4 - The two pipeline topologies are compared with evidence (Priority: P2)

An engineer selects either pipeline topology with one configuration value, runs the same
scripted conversation over both against the same number, and gets numbers showing what each
costs and what each is worth.

**Why this priority**: P2 because a single working pipeline already proves the architecture.
But this is the question the POC exists to answer (Principle XI), and an unmeasured
preference between them is exactly the kind of assertion Principle IX forbids.

**Independent Test**: Set the mode to cascaded, run the scripted call, record the numbers.
Set it to speech-to-speech, change nothing else, run the identical script, record the
numbers. Compare.

**Acceptance Scenarios**:

1. **Given** the service, **When** the pipeline mode is changed and the service restarted,
   **Then** the other topology runs with no code edit, no change to the transport, the tool
   bridge or the authorization gate, and no change to the phone number's configuration.
2. **Given** the cascaded topology, **When** any single stage's provider is changed by
   configuration, **Then** the pipeline runs on the new provider with no code edit and the
   other two stages untouched.
3. **Given** both topologies, **When** the same scripted conversation is run over each,
   **Then** per-stage and end-to-end latency figures are produced for both.
4. **Given** the recorded results, **When** the comparison is written up, **Then** it states
   how the numbers were obtained, over how many calls, and what would invalidate them.

---

### User Story 5 - An engineer can see what happened on a call (Priority: P2)

After any call, an engineer can reconstruct it: when the stream opened, what the caller
said, what the assistant decided, which tools ran and how long each took, where the time
went, and why the call ended.

**Why this priority**: P2 because calls can succeed without it, but Story 4 is impossible
without it and every failure investigation depends on it.

**Independent Test**: Complete one call, then reconstruct the entire session from logs and
the case timeline alone, with no access to the running process.

**Acceptance Scenarios**:

1. **Given** any voice session, **When** it starts, **Then** it carries the case correlation
   id from the first frame, and a session that has no case id refuses to run.
2. **Given** a completed turn, **When** logs are inspected, **Then** time to first
   transcript, time to first model token, time to first audio, and end-to-end turn latency
   are all recorded.
3. **Given** a tool invocation, **When** logs are inspected, **Then** the tool name, its
   outcome, and its round-trip duration are recorded.
4. **Given** any log output from the voice service, **When** it is inspected, **Then** it
   contains no passcode, credential, secret, or unnecessary personal data.
5. **Given** a call that ended, **When** the case is inspected, **Then** the reason it ended
   is recorded and distinguishes caller hang-up, escalation, and failure.

---

### User Story 6 - The privileged channel between the pipeline and UCC is closed (Priority: P2)

The voice pipeline runs as a separate process and can execute privileged tools. Only the
voice pipeline can use that channel, and only for the call it is actually serving.

**Why this priority**: P2 in sequencing — it can follow a working pipeline — but it is a
constitutional requirement (Principle X) and the severity is real: the channel executes
protected tools and is currently open to anything that can reach the service.

**Independent Test**: Call the tool-execution endpoint without a credential and confirm
rejection. Call it with a valid credential but a case id the session does not own, and
confirm rejection.

**Acceptance Scenarios**:

1. **Given** the tool-execution channel, **When** a request arrives without a valid service
   credential, **Then** it is rejected and no tool runs.
2. **Given** a valid service credential, **When** a request names a case the caller's
   session is not bound to, **Then** it is rejected.
3. **Given** the credential, **When** logs and the browser bundle are inspected, **Then**
   the credential appears in neither.
4. **Given** a missing credential at startup, **When** the service starts, **Then** it
   refuses to serve rather than falling back to an open channel.

---

### User Story 7 - Failures degrade safely rather than confusingly (Priority: P3)

When something downstream breaks mid-call, the caller gets a truthful, calm sentence and a
route to a human — never silence, never a stack trace, never an invented answer.

**Why this priority**: P3 because it is exercised by fault injection rather than the happy
path, but it is what separates a demo from something that could be trusted with real callers.

**Independent Test**: Force each dependency to fail in turn during a live call and confirm
the caller hears an appropriate sentence and the case reflects the failure.

**Acceptance Scenarios**:

1. **Given** a call, **When** the knowledge base or the university records are unavailable,
   **Then** the assistant says it cannot retrieve that right now and offers a human; it
   never substitutes remembered or plausible content.
2. **Given** a call, **When** a tool call times out, **Then** the caller is not left in
   silence and the turn resolves within a bounded time.
3. **Given** a call, **When** speech recognition, inference, or synthesis fails, **Then**
   the caller is told plainly and the call is escalated rather than dropped.
4. **Given** any failure, **When** the caller hears the response, **Then** it contains no
   technical detail, error code, or internal identifier.
5. **Given** any failure, **When** the internal record is inspected, **Then** it contains
   the structured detail the caller was not given.

### Edge Cases

- Caller hangs up mid-greeting, mid-answer, or mid-tool-call.
- Caller says nothing at all after connecting.
- Caller talks continuously without pausing, so no turn boundary is detected.
- The stream opens without a case correlation id.
- The same provider event is delivered twice.
- A caller with no record on file asks about "my application".
- A caller reads the passcode back with digits spoken as words, or with pauses.
- A caller asks for a human while the assistant is mid-tool-call.
- The public tunnel URL changes while a call is in progress.
- Two calls arrive at once on the same service instance.
- The service is restarted while a call is live.
- The caller is on a poor line, so transcripts arrive garbled.

---

## Requirements *(mandatory)*

### Functional Requirements

**Call handling**

- **FR-001**: The system MUST answer an inbound call to the POC number and begin a voice
  conversation without the caller taking any action beyond dialling. A fixed greeting MUST
  be spoken by the telephony layer while the audio stream is being established, so the
  caller never hears silence on answer. The assistant MUST then listen rather than speaking
  a second greeting of its own, and MUST behave identically in this respect in both
  topologies.
- **FR-002**: The system MUST open exactly one case per call, at call start, before the
  conversation begins — including for calls abandoned during the greeting.
- **FR-003**: The system MUST support the caller interrupting the assistant, and MUST stop
  speaking when interrupted.
- **FR-004**: The system MUST maintain conversational context across turns within a call.
- **FR-005**: The system MUST close the session and record an end reason when the caller
  disconnects, distinguishing hang-up, escalation and failure.
- **FR-006**: A voice session that does not carry a case correlation id MUST refuse to run.

**Knowledge and truthfulness**

- **FR-007**: Public questions MUST be answered from the existing knowledge base; the system
  MUST NOT introduce a second knowledge store.
- **FR-008**: When retrieval returns nothing usable, the system MUST say so and offer a
  human. It MUST NOT answer from model memory.
- **FR-009**: The system MUST NOT state transactional student data that did not come from
  the authoritative records service.
- **FR-010**: When a tool refuses a request, the system MUST relay the refusal and the real
  remediation path, and MUST NOT invent a substitute procedure.

**Protected data**

- **FR-011**: Protected data MUST NOT be disclosed before successful identity verification
  on the current call.
- **FR-012**: Every protected tool invocation MUST be authorized server-side from persisted
  state, independently of anything the model or the caller asserts.
- **FR-013**: When a caller holds more than one application, the system MUST disambiguate
  before answering and MUST NOT choose one.
- **FR-014**: Verification MUST enforce expiry, an attempt limit, and binding to the current
  call.

**Escalation**

- **FR-015**: The system MUST escalate on explicit caller request and on unrecoverable
  failure.
- **FR-016**: On escalation the voice session MUST close and the assistant MUST stop
  speaking before the transfer proceeds.
- **FR-017**: The escalated call MUST reach a human agent, and the agent MUST see the case,
  the summary and the verification status on answering.
- **FR-018**: When no agent is available, the caller MUST be told and a callback recorded.
- **FR-019**: A failed transfer MUST leave the case open and MUST tell the caller the truth.

**Pipeline architecture**

- **FR-020**: The system MUST provide both a cascaded topology (speech recognition,
  inference, speech synthesis as separate stages) and a speech-to-speech topology.
- **FR-021**: Selecting the topology MUST be a configuration change only.
- **FR-022**: Replacing the provider at any single cascaded stage MUST be a configuration
  change only, leaving the other stages, the transport, the tool bridge and the
  authorization gate untouched.
- **FR-023**: Both topologies MUST use the same transport, the same audio serialization, the
  same tool bridge and the same authorization gate.
- **FR-024**: The voice pipeline MUST fetch the tool catalogue from UCC at session start and
  MUST NOT hold its own copy of any tool schema.
- **FR-025**: The voice pipeline MUST contain no tool implementation, no authorization
  decision, and no persistence of case, ticket or identity state.
- **FR-026**: An invalid configuration MUST cause the service to refuse to start rather than
  silently falling back to another topology or provider.

**Security**

- **FR-027**: The tool-execution channel between the voice pipeline and UCC MUST require a
  service credential that proves the caller is the voice pipeline.
- **FR-028**: That channel MUST additionally require a per-call token, minted by UCC, bound
  to exactly one case, and MUST reject a request for any other case — including a request
  bearing a valid service credential.
- **FR-029**: The per-call token MUST expire, and MUST be rejected after the call it belongs
  to has ended.
- **FR-030**: The service MUST refuse to start if the service credential is absent.
- **FR-031**: Credentials and secrets MUST be sourced from the environment and MUST NOT be
  committed to the repository or delivered to a browser. (Log hygiene is FR-037.)
- **FR-032**: Inbound webhooks MUST remain signature-verified. Any bypass MUST be an
  explicit, loudly-logged, local-only opt-in.

**Observability**

- **FR-033**: Every voice session MUST carry the case correlation id on every log line.
- **FR-034**: The system MUST record, per turn: time to first transcript, time to first
  model token, time to first audio, and end-to-end turn latency.
- **FR-035**: The system MUST record tool name, outcome and round-trip duration for every
  tool invocation.
- **FR-036**: Session lifecycle transitions MUST be logged: stream open, first audio,
  escalation, close, and close reason.
- **FR-037**: Logs MUST NOT contain passcodes, credentials, secrets, or unnecessary personal
  data.
- **FR-038**: Logs MUST be structured.

**Failure handling**

- **FR-039**: Every dependency call MUST have a bounded timeout.
- **FR-040**: Every failure MUST produce a structured internal record and a safe
  caller-facing sentence containing no technical detail.
- **FR-041**: A dependency failure MUST NOT terminate the call silently.

**Verification of the work itself**

- **FR-042**: The voice service MUST import and start against its own pinned dependencies.
- **FR-043**: The voice service MUST have automated tests covering tool-schema conversion,
  the tool bridge client, session binding, configuration selection, and failure handling.
- **FR-044**: The escalation-to-human path MUST be validated on a real phone call, not only
  in automated tests.
- **FR-045**: Documentation MUST distinguish what has been executed and verified from what
  has only been implemented.

**Scenarios added after cross-artifact analysis**

These six were surfaced by the security checklist as scenarios the requirements neither
specified nor excluded. Five are now specified; the sixth is explicitly excluded in
Assumptions.

- **FR-046**: If the tool catalogue cannot be fetched at session start, the system MUST
  refuse the session rather than run a conversation with no tools. An assistant that can
  only talk, with no ability to retrieve or verify, is precisely the ungoverned conversation
  FR-006 exists to prevent.
- **FR-047**: The per-call token's lifetime MUST exceed the maximum supported call duration.
  If a token nevertheless expires mid-call, the tool call MUST be refused and the call
  escalated — never silently retried and never allowed to proceed unauthorised.
- **FR-048**: When a session is refused, the caller MUST hear a brief spoken explanation and
  the call MUST be ended deliberately. A refused session MUST NOT leave the caller listening
  to silence.
- **FR-049**: The voice leg's conversation MUST be captured into the existing transcript, so
  an escalated case reaches the agent with its AI segment present rather than empty.
- **FR-050**: A mismatch between the service credential held by the voice service and the one
  held by UCC MUST be detected at startup, not on the first tool call of the first real
  caller.

### Key Entities

- **Voice session** — one live audio conversation. Bound to exactly one case for its whole
  life. Holds no authorization state of its own.
- **Pipeline topology** — cascaded or speech-to-speech. A configuration value, not a code
  path chosen at runtime by inspection.
- **Stage provider** — the chosen supplier for speech recognition, inference, or speech
  synthesis. Independently replaceable.
- **Turn** — one caller utterance and the assistant's response to it. The unit that latency
  is measured against.
- **Tool invocation** — a request from the model, adjudicated by UCC, with an outcome and a
  duration. Never executed by the voice pipeline itself.
- **Service credential** — proves the voice pipeline's identity to UCC. Distinct from any
  caller or agent identity.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A caller dialling the number hears the greeting immediately on answer, with no
  audible silence beforehand, and their first utterance after the greeting is understood —
  measured as zero lost opening utterances across the scripted call set.
- **SC-002**: In the speech-to-speech topology, the assistant begins responding within 1
  second of the caller finishing a sentence, on a turn requiring no record lookup.
- **SC-003**: In the cascaded topology, the assistant begins responding within 2.5 seconds
  of the caller finishing a sentence, on a turn requiring no record lookup.
- **SC-004**: A turn requiring a record lookup adds no more than 1.5 seconds over the same
  topology's baseline.
- **SC-005**: When a caller interrupts, the assistant stops speaking within 500 milliseconds.
- **SC-006**: Across at least 10 scripted calls, protected data is disclosed on 0 occasions
  where verification had not succeeded on that call.
- **SC-007**: An unverified caller who claims to be verified is refused on 100% of attempts,
  and the recorded verification state remains negative in every case.
- **SC-008**: A caller asking for a human is speaking to one, or has a recorded callback,
  within 30 seconds of asking — confirmed by the caller, not by database state alone.
- **SC-009**: Across at least 10 scripted calls, the assistant states no specific fact about
  a caller's record that did not come from the records service.
- **SC-010**: Switching topology requires changing exactly one configuration value and
  restarting; switching any single cascaded provider likewise.
- **SC-011**: Both topologies complete the same scripted conversation over the same phone
  number, and their latency figures are published side by side.
- **SC-012**: Any completed call can be fully reconstructed from logs and the case timeline
  alone.
- **SC-013**: No passcode, credential or secret appears in any log line, across the full
  test corpus.
- **SC-014**: The tool-execution channel rejects 100% of unauthenticated requests and 100%
  of requests for an unbound case.
- **SC-015**: Every simulated dependency failure produces a spoken response that is
  truthful, contains no technical detail, and offers a route forward.
- **SC-016**: The voice service's automated tests pass from a clean checkout following only
  the documented setup steps.
- **SC-017**: Every capability listed as working in the final report has been executed at
  least once, and anything not executed is labelled as such.

---

## Assumptions

**Reused, not rebuilt**

- The existing tool catalogue, authorization gate, verification service, knowledge base,
  application APIs, ticketing, routing and agent softphone are correct and are consumed
  as-is. Defects found in them are logged, not redesigned here.
- The existing Twilio webhook layer — inbound answer URL, handoff action URL, status
  callbacks and signature verification — is reused. The voice pipeline changes what happens
  *inside* the media stream, not how the call arrives or departs.
- The existing ticket-per-call model satisfies the ticketing requirement. No separate
  ticket-creation tool and no external ticketing system is introduced.

**Provider defaults** (decided in Clarifications, justified in the plan)

- All three cascaded stages default to AWS: Amazon Transcribe for speech recognition,
  Bedrock Claude for inference, Amazon Polly for synthesis. This adds no vendor account, no
  new credential, and keeps caller audio within the account boundary the security
  documentation already describes.
- Inference therefore stays on the same model as the existing text path, so answers are
  comparable across paths and any difference is attributable to the voice layer.
- These defaults are expected to be slower than a best-of-breed pairing. Because provider
  choice is configuration (FR-022), the assumption is testable: if the cascaded topology
  misses SC-003, swapping one stage is the first remedy, not a redesign.
- Speech-to-speech uses the model version already spiked and measured in this repository;
  the earlier version is excluded because it did not emit tool requests.

**Environment**

- Development is local, with a public tunnel exposing the service to the telephony provider.
  No new cloud infrastructure is provisioned for this feature.
- Two ports must now be publicly reachable — the UCC API and the voice service.
- Only the dedicated POC phone number is touched. Other numbers on the same telephony
  account carry production traffic and are out of bounds.
- The demo tenant, seeded callers and seeded applications are used; no real student data.
- The demo passcode remains fixed and labelled as such. Real passcode delivery is out of
  scope.

**Scope boundaries**

- Closing the *end-user* authentication gap across the wider API is out of scope. Only the
  privileged channel between the voice pipeline and UCC is closed here. The wider gap remains
  documented.
- The existing text-based voice path remains available and working; this feature adds a path
  rather than replacing one.
- "Measured" means a fixed script of caller utterances, run over both topologies against the
  same number, with at least 5 calls per topology, reporting median and worst observed.
- Two distinct scripted corpora are required and must not be conflated: a **latency corpus**
  (5 calls per topology, driving SC-002 through SC-005 and SC-011) and a **security corpus**
  (at least 10 calls, driving SC-006, SC-007 and SC-009). They measure different things and a
  single run cannot serve both.
- **DTMF passcode entry is out of scope**, and this is a deliberate exclusion rather than an
  oversight. Real callers routinely key a code rather than speak it, so this is the first
  thing to add before any non-demo use. It is excluded here because the POC uses a fixed
  demo passcode, the existing text path is also speech-only, and wiring keypad capture
  through to the verification flow is a self-contained feature that would not change any
  conclusion this POC exists to reach. Recorded as a known limitation, not as done.

**Out of scope**

- Amazon Connect, external ticketing systems, supervisor dashboard changes, new cloud
  infrastructure, frontend work, multi-region, production deployment, call recording capture,
  and multi-language support.
