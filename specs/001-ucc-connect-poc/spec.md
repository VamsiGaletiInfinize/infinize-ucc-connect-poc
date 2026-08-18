# Feature Specification: Infinize Unified Contact Center (UCC) — Amazon Connect + Bedrock POC

**Feature Branch:** `001-ucc-connect-poc`
**Created:** 2026-08-14
**Status:** In Implementation
**Constitution:** `.specify/memory/constitution.md` v1.0.0

## Objective

Prove, with a working end-to-end reference implementation, whether
`Amazon Connect + Amazon Bedrock + UCC` is a stronger architecture for the Infinize
Unified Contact Center than the incumbent `Vapi + Twilio + UCC`.

The deliverable is a demonstrable contact center, not a document describing one.

## Demo Tenant

Infinize University — a fictional institution. No real university data is used.

Departments: **Admissions**, **Financial Aid**, **Technical Support**, **General**.

## User Scenarios (Acceptance)

The POC is not complete until every scenario below passes.

### SC-1 — Public FAQ (P0)
**Given** a caller asks "What documents are required for admission?"
**When** the AI orchestrator handles the contact
**Then** it retrieves from the public Knowledge Base, answers, and the ticket reaches
`AI_RESOLVED` → `CLOSED` with no verification required.

### SC-2 — Protected Data With Verification (P0)
**Given** an applicant asks "What is my application status?"
**When** the AI attempts a protected lookup
**Then** the backend requires verification, an OTP is issued, the caller verifies, the
backend authorizes, the university Application API is called, and only then is status
disclosed.

### SC-3 — Security Denial (P0)
**Given** an unverified caller asks for application status
**When** the protected tool is invoked
**Then** the backend DENIES server-side and no protected field is disclosed — even if the
model requests the data or is manipulated into asserting the caller is verified.

### SC-4 — Multiple Applications (P0)
**Given** an applicant holds `APP-001` (M.Tech CS, `UNDER_REVIEW`) and `APP-002`
(MBA, `ADMITTED`)
**When** the caller asks about "my application"
**Then** the AI MUST disambiguate and MUST NOT arbitrarily select one.

### SC-5 — AI Escalation (P0)
**Given** a caller says "I need to speak with an admissions officer"
**When** escalation is requested
**Then** UCC resolves the department, enters the Admissions queue, and the ticket moves
`ESCALATED` → `QUEUED_FOR_AGENT`.

### SC-6 — Agent Resolution (P0)
**Given** a queued contact
**When** an agent accepts, adds notes, and resolves
**Then** the ticket moves `AGENT_ASSIGNED` → `AGENT_HANDLING` → `RESOLVED` → `CLOSED`
and the agent is bound to the ticket.

### SC-7 — Callback (P1)
**Given** no agent is available
**When** the caller requests a callback
**Then** the callback is queued, later completed by an agent, and both events appear on
the ticket timeline.

### SC-8 — Outbound Application Deadline Reminder (P1)
**Given** an outbound campaign targeting applicants with pending documents
**When** the campaign runs
**Then** each outbound contact produces its own `UccCall` and `UccTicket`.

### SC-9 — Supervisor (P1)
**Given** live contacts in progress
**When** a supervisor opens the dashboard
**Then** active calls, AI vs agent split, waiting calls, agent availability, queue depth,
escalations, and open tickets are shown and update in realtime.

## Functional Requirements

- **FR-001** Every inbound and outbound contact creates exactly one `UccCall` and one `UccTicket`.
- **FR-002** `UccTicket` transitions are validated against an explicit state machine; invalid transitions are rejected.
- **FR-003** Ticket status MUST NOT be settable arbitrarily from the frontend.
- **FR-004** All 24 normalized call events are recorded on an append-only timeline.
- **FR-005** Duplicate provider events are idempotent across calls, tickets, timeline, and agent assignment.
- **FR-006** Public questions are answered from the Knowledge Base via retrieval, with citations.
- **FR-007** Protected data requires successful identity verification before disclosure.
- **FR-008** OTP is `123456`, labelled `DEMO ONLY`, with attempt limits and expiry.
- **FR-009** Every protected tool re-validates identity, tenant, ownership, verification, and authorization server-side.
- **FR-010** Cross-tenant access is denied at the repository boundary.
- **FR-011** Application API failure escalates; it never fabricates data.
- **FR-012** Knowledge Base failure escalates.
- **FR-013** Escalation resolves a department and enters the corresponding queue.
- **FR-014** Agents have routing profiles and availability; unavailable-agent path offers queue or callback.
- **FR-015** Recording metadata is stored in UCC; binaries live in S3, never in DynamoDB.
- **FR-016** Transcripts cover both AI and agent conversation segments.
- **FR-017** Correlation across ticket → call → provider contact → events → transcript → recording is queryable.
- **FR-018** Realtime updates drive live call status, agent status, queue depth, and ticket changes.
- **FR-019** Logs never contain OTP, credentials, or secrets.
- **FR-020** Frontend never holds AWS credentials; all AWS access is server-side.

## Key Entities

- **UccCall** — the telephony interaction, correlated to a provider contact.
- **UccTicket** — the business case, with lifecycle state and resolution.
- **UccEvent** — normalized, idempotent, append-only timeline entry.
- **Caller** — identity and caller type (`PROSPECT`, `APPLICANT`, `STUDENT`, `PARENT`, `GUARDIAN`, `FACULTY`, `STAFF`, `ALUMNI`, `VENDOR`, `UNKNOWN`).
- **Application** — protected transactional record owned by the university system of record.
- **Agent**, **Department**, **Queue**, **VerificationSession**, **Recording**, **Transcript**.

## Out of Scope (P2)

Advanced analytics, advanced campaign management, advanced admin configuration, advanced
UI theming.

## Success Criteria

- **Su-1** All P0 scenarios pass in automated tests and live demo.
- **Su-2** Security scenarios (unverified access, cross-tenant, invalid/expired OTP, prompt injection) are denied server-side.
- **SU-3** A developer can trace any ticket to its provider contact and full event timeline.
- **SU-4** The Connect vs Vapi/Twilio comparison is grounded in POC evidence, including Connect's weaknesses.
