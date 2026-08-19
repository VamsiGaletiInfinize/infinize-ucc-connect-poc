<!--
SYNC IMPACT REPORT
==================
Version change: 1.0.0 -> 2.0.0 (MAJOR)

Rationale for MAJOR: Principle I is redefined, not clarified. The ownership boundary it
fixes named Amazon Connect as the telephony owner and had no concept of a real-time voice
orchestration layer. Both change. Any artifact that complied with Principle I v1.0.0 by
routing telephony through Amazon Connect no longer complies.

Modified principles:
  - I. "The Contact Center Platform Owns Telephony; UCC Owns the Business"
    -> "The Platform Owns Telephony; Pipecat Owns the Voice Leg; UCC Owns the Business"
       Restated provider-neutrally. Telephony owner is now the platform in use (Twilio +
       TaskRouter today, Amazon Connect if unblocked). Adds the real-time voice leg as a
       distinct, separately-owned concern.
  - V. "Everything Is Traceable" — extended to require the voice leg to carry the same
       correlation id and to emit per-stage latency. No change to its meaning.
  - VIII. "Credible Production Path" — the scale question is unchanged; the worked example
       now names long-lived stateful streams, which the POC's voice leg introduces.

Added sections:
  - X. The Voice Pipeline Carries No Policy (NEW)
  - XI. Provider Choice Is Configuration, and Both Pipelines Must Be Measured (NEW)

Removed sections: none.

Numbering note: Principles I-IX keep their numbers. Approximately 20 source files and ADRs
cite principles by number (e.g. packages/types/src/security.ts cites Principle III). The two
new principles are therefore appended as X and XI rather than inserted next to the
principles they extend. Cross-references remain valid.

Deferred items:
  - TODO(STALE_CITATIONS): apps/ucc-api/src/routes/twilio.ts:136 cites "Principle III" for
    every-call-is-a-case, which is Principle II. packages/types/src/ticket-state-machine.ts:16
    cites "Principle VII" for FR-003. Both predate this amendment; correct them opportunistically.
-->

# Infinize UCC Voice AI POC — Constitution

**Version:** 2.0.0
**Ratified:** 2026-08-14
**Last Amended:** 2026-08-19
**Status:** Active

The purpose of this POC is to prove whether **Twilio + Pipecat + STT/LLM/TTS + UCC** is a
viable architecture for the Infinize Unified Contact Center — a caller dials a number, an AI
assistant answers, retrieves from the public knowledge base, reaches protected student data
only through a server-side authorization gate, and hands off to a human when it should.

This supersedes v1.0.0, which framed the question as *Amazon Connect + Bedrock vs
Vapi + Twilio*. That question was answered as far as the environment permits: Amazon Connect
instance creation is denied organisation-wide by SCP `p-qocf1ngi`, reproduced across two AWS
accounts (ADR-0004). Telephony therefore runs on Twilio. The ownership boundary the original
constitution existed to protect is unchanged — only the name of the platform enforcing it.

These principles are binding on every artifact in this repository.

---

## Core Principles

### I. The Platform Owns Telephony; Pipecat Owns the Voice Leg; UCC Owns the Business

UCC MUST NOT reimplement telephony, routing engines, queueing, or agent state machines that
the telephony platform already provides. UCC MUST NOT reimplement audio transport,
turn-taking, or barge-in that the voice orchestration layer already provides.

| Concern | Owner |
|---|---|
| Telephony, phone numbers, call control, queues, workers, agent presence, transfer, callback, recording capture | **Telephony platform** — Twilio + TaskRouter today; Amazon Connect if the SCP is lifted |
| Audio transport, serialization, voice activity detection, turn-taking, barge-in, pipeline orchestration | **Pipecat** |
| Speech recognition, reasoning, speech synthesis | **The configured STT / LLM / TTS providers** |
| Tenant, caller, caller type, identity, verification, authorization, business rules, AI policy, case management, ticket lifecycle, audit | **UCC** |
| Public university information | **Knowledge Base (RAG)** |
| Transactional student/application data | **University APIs — never RAG** |

A design that pulls platform responsibilities into UCC is a violation. A design that pulls
UCC responsibilities into the voice pipeline is a violation of equal severity — see
Principle X.

**Rationale:** the incumbent architecture's weakness is that UCC absorbs contact-centre
responsibilities it should not own. Adding a real-time voice layer creates a second, subtler
version of the same failure: business logic drifting into the pipeline because that is where
the conversation is happening. Both directions are named here so both are reviewable.

### II. Every Call Is a Case

Every inbound and outbound contact MUST produce a `UccCall` **and** a `UccTicket` at call
start — never only on escalation. A `UccTicket` is the business case; it is not a copy of the
`UccCall`.

**Rationale:** a contact center that only records escalations cannot report on AI
containment, deflection rate, or first-contact resolution.

### III. Authorization Is Server-Side, Never Prompt-Side

An LLM MAY *request* an action. The UCC backend DECIDES whether it is permitted.

Every protected tool MUST independently re-validate, server-side, on every invocation:
caller identity, tenant, resource ownership, verification state, and authorization —
regardless of what the model claims. A system prompt is NOT an access control mechanism.

**Rationale:** prompt-based authorization fails to prompt injection and model error. This is
the single most important security property of the POC.

### IV. Never Fabricate Transactional Data

RAG MUST NOT be the authoritative source for application or student data. If a university
API is unavailable or returns an error, the AI MUST escalate to a human. It MUST NOT guess,
infer, or synthesize a plausible answer.

This extends to process. A model that is refused MUST relay the refusal and the real
remediation path; it MUST NOT invent a substitute procedure. A tool's denial message MUST
state the remediation explicitly so the model has something true to say.

**Rationale:** a hallucinated admission decision is an unacceptable institutional risk. A
hallucinated *verification procedure* — asking a caller for date of birth when the real flow
is a one-time passcode — trains callers to disclose personal data on request, which is worse
than unhelpful.

### V. Everything Is Traceable

Every interaction MUST be traceable across `UccTicketId` -> `UccCallId` -> provider contact
id -> events -> transcript -> recording -> agent -> resolution. Every log line carries a
correlation id.

The voice leg is not exempt. A voice session MUST carry the same `uccCallId` from the moment
the stream opens, and MUST refuse to run ungoverned if it does not have one. It MUST emit
session lifecycle and per-stage latency — time to first transcript, first token, first
audio, tool round-trip — because Principle XI cannot be satisfied by a pipeline that does not
measure itself.

Logs MUST NEVER contain OTP values, credentials, secrets, or unnecessary student PII.

### VI. Idempotent Event Processing

Telephony providers deliver events at-least-once. Duplicate provider events MUST NOT create
duplicate calls, tickets, timeline entries, or agent assignments. Idempotency is enforced at
the persistence layer, not by hoping events arrive once.

### VII. Do Not Fake Core Functionality

A mocked capability MUST be visibly labelled `POC MOCK` in the UI and documented with the
reason and the production replacement. Buttons that only report success are prohibited.

Code that has never been executed MUST NOT be described as working. "Implemented" and
"verified" are different claims and MUST be reported separately.

**Rationale:** the second paragraph is added from experience. This repository contained a
voice service that was committed, documented and listed as a capability, but had never been
installed or run — and did not import against its own pinned dependency.

### VIII. Credible Production Path

Every decision is tested against: *"does this still hold at 100 universities, thousands of
agents, millions of calls?"* Where the POC deliberately simplifies, the production
alternative MUST be documented in an ADR.

A real-time voice leg requires a long-lived stateful stream per active call. That forecloses
Lambda, makes concurrent open streams the scaling unit, and makes connection draining a
deployment concern. This MUST be stated as a deliberate cost, not discovered later.

Simplify the POC; do not over-engineer it; do not pretend the simplification is the
production design.

### IX. Evidence Over Advocacy

Architectural conclusions MUST be grounded in what this POC actually demonstrated, including
where the chosen approach is weaker. A conclusion reached by assertion rather than evidence
is a failed deliverable.

A measurement MUST record how it was obtained and what would invalidate it. A negative
result MUST be checked for whether the harness caused it before it is reported as a property
of the thing under test.

### X. The Voice Pipeline Carries No Policy

The voice pipeline owns the real-time leg and nothing else. It MUST NOT contain:

- tool implementations or business logic
- its own copy of the tool catalogue or tool schemas
- any authorization decision, verification state, or caller entitlement
- any persistence of case, ticket, or identity state

It MUST fetch the tool catalogue from UCC at session start, and it MUST execute every tool
through the UCC gate, which rebuilds the security context from persisted state. A tool
result — including a denial — is relayed to the model verbatim. The pipeline MUST NOT
interpret, cache, soften, or substitute a result, and MUST NOT invent a fallback answer when
a tool fails.

Because the pipeline runs out of process, the channel it uses to reach UCC is a privileged
inter-service boundary and MUST be authenticated, with the session bound to the call it
claims to be serving.

**Rationale:** Principle III holds because the gate reads persisted state and knows nothing
about which model asked. Moving the model into a separate process must not move the security
boundary with it. Stated positively: if the entire voice pipeline were hostile, it should
still obtain no protected data.

### XI. Provider Choice Is Configuration, and Both Pipelines Must Be Measured

Selecting a speech-to-text, inference, or text-to-speech provider MUST be a configuration
change, not a code change. Swapping any one stage MUST NOT require edits to the transport,
the serializer, the tool bridge, the UCC gate, or the other two stages.

The POC MUST support both pipeline topologies behind a single switch:

| Mode | Shape |
|---|---|
| **cascaded** | transport -> STT -> context -> LLM (tools) -> TTS -> transport |
| **speech-to-speech** | transport -> context -> unified speech model (tools) -> transport |

Both MUST use the same transport, the same serializer, the same tool bridge and the same UCC
gate. They MUST be measured on the same phone number against the same corpus, and the
latency and quality trade-off between them MUST be reported as data.

**Rationale:** speech-to-speech is faster and sounds better; cascaded is swappable,
debuggable, and lets reasoning stay on a chosen model. Which trade is right is a real
engineering question, and this POC exists to answer it with numbers rather than to assume it.
Building only one mode would make the answer unfalsifiable.

---

## Security Requirements

These are not aspirational; they are the minimum bar for the POC to be considered honest.

- Secrets come from the environment. No credential is committed, logged, or sent to a browser.
- Every public webhook is signature-verified against the provider's auth token. Any
  verification bypass MUST be an explicit, loudly-logged, local-only opt-in.
- Browser clients receive short-lived scoped tokens, never account-wide credentials.
- Tenant isolation is structural — part of the partition key — not a filter applied by
  application code that might be forgotten.
- Every known security gap MUST be documented in `docs/security.md` and flagged at the point
  in the code where it exists. A gap that is known and written down is acceptable in a POC.
  A gap that is known and unwritten is not.

## Development Workflow

- Spec Kit is the source of truth for requirements: constitution -> specify -> clarify ->
  plan -> checklist -> tasks -> analyze -> implement -> converge. Quality gates are not
  skipped because the POC is small.
- Beads is the execution tracker. Every meaningful implementation unit is an issue with
  explicit dependencies, and implementation follows the dependency graph.
- If `analyze` finds a contradiction between spec, plan and tasks, work STOPS and the
  specification is fixed. Contradictions are not coded around.
- Tests accompany the code they cover. A service with no tests is not done, in any language.
- Architecturally significant decisions are recorded as ADRs, including the ones that turned
  out to be wrong.

## Governance

This constitution supersedes ad-hoc preference. Amendments require a version bump and a
recorded rationale in the Sync Impact Report at the head of this file.

Versioning is semantic: **MAJOR** for a principle removed or redefined such that previously
compliant work no longer complies; **MINOR** for a principle added or materially expanded;
**PATCH** for clarification and wording.

Principles are numbered permanently. Source files cite them by number, so an amendment
appends rather than renumbers.

Priority order is fixed: **P0 correctness and security > P1 breadth > P2 polish.** P0 is
never sacrificed for P2.

**Version**: 2.0.0 | **Ratified**: 2026-08-14 | **Last Amended**: 2026-08-19
