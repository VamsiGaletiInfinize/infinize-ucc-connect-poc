# Infinize UCC Connect POC — Constitution

**Version:** 1.0.0
**Ratified:** 2026-08-14
**Status:** Active

The purpose of this POC is to determine whether **Amazon Connect + Amazon Bedrock + UCC**
is a stronger foundation for the Infinize Unified Contact Center than the incumbent
**Vapi + Twilio + UCC** architecture.

These principles are binding on every artifact in this repository.

---

## Principle I — The Contact Center Platform Owns Telephony; UCC Owns the Business

UCC MUST NOT reimplement telephony, routing engines, queueing, or agent state machines
that the contact center platform already provides.

| Concern | Owner |
|---|---|
| Telephony, phone numbers, contact flows, queues, routing profiles, agent presence, transfer, callback, recording | Amazon Connect |
| Tenant, caller, caller type, identity, verification, authorization, business rules, AI policy, case management, ticket lifecycle, audit | UCC |
| Model inference and reasoning | Amazon Bedrock |
| Public university information | Knowledge Base (RAG) |
| Transactional student/application data | University APIs (never RAG) |

**Rationale:** the incumbent architecture's weakness is that UCC absorbs contact-center
responsibilities it should not own. Any design that pulls Connect responsibilities into
UCC is a violation.

## Principle II — Every Call Is a Case

Every inbound and outbound contact MUST produce a `UccCall` **and** a `UccTicket` at call
start — never only on escalation. A `UccTicket` is the business case; it is not a copy of
the `UccCall`.

**Rationale:** a contact center that only records escalations cannot report on AI
containment, deflection rate, or first-contact resolution.

## Principle III — Authorization Is Server-Side, Never Prompt-Side

An LLM MAY *request* an action. The UCC backend DECIDES whether it is permitted.

Every protected tool MUST independently re-validate, server-side, on every invocation:
caller identity, tenant, resource ownership, verification state, and authorization —
regardless of what the model claims. A system prompt is NOT an access control mechanism.

**Rationale:** prompt-based authorization fails to prompt injection and model error. This
is the single most important security property of the POC.

## Principle IV — Never Fabricate Transactional Data

RAG MUST NOT be the authoritative source for application or student data. If a university
API is unavailable or returns an error, the AI MUST escalate to a human. It MUST NOT
guess, infer, or synthesize a plausible answer.

**Rationale:** a hallucinated admission decision is an unacceptable institutional risk.

## Principle V — Everything Is Traceable

Every interaction MUST be traceable across `UccTicketId` → `UccCallId` →
provider contact id → events → transcript → recording → agent → resolution. Every log line
carries a correlation id.

Logs MUST NEVER contain OTP values, credentials, secrets, or unnecessary student PII.

## Principle VI — Idempotent Event Processing

Contact-center providers deliver events at-least-once. Duplicate provider events MUST NOT
create duplicate calls, tickets, timeline entries, or agent assignments. Idempotency is
enforced at the persistence layer, not by hoping events arrive once.

## Principle VII — Do Not Fake Core Functionality

A mocked capability MUST be visibly labelled `POC MOCK` in the UI and documented with the
reason and the production replacement. Buttons that only report success are prohibited.
Core functionality uses real AWS services.

## Principle VIII — Credible Production Path

Every decision is tested against: *"does this still hold at 100 universities, thousands of
agents, millions of calls?"* Where the POC deliberately simplifies, the production
alternative MUST be documented in an ADR. Simplify the POC; do not over-engineer it; do
not pretend the simplification is the production design.

## Principle IX — Evidence Over Advocacy

The Connect-vs-Vapi/Twilio comparison MUST be grounded in what this POC actually
demonstrated, including where Amazon Connect is weaker. A conclusion that Amazon Connect
wins by assertion rather than evidence is a failed deliverable.

---

## Governance

This constitution supersedes ad-hoc preference. Amendments require a new version and a
recorded rationale. Priority order is fixed: **P0 correctness and security > P1 breadth >
P2 polish.** P0 is never sacrificed for P2.
