# Ticket lifecycle

## Every call is a case

A `UccCall` **and** a `UccTicket` are created at call start, for every inbound and outbound
contact — never only on escalation.

Without this, the contact centre cannot report AI containment, deflection rate or
first-contact resolution, because the denominator does not exist.

## UccCall vs UccTicket

They are deliberately different entities.

| | UccCall | UccTicket |
|---|---|---|
| Represents | The telephony interaction | The business case |
| Lifetime | Ends when the call ends | Outlives the call |
| Owns | Provider contact id, direction, duration, recording, transcript | Category, priority, verification, ownership, resolution, notes |
| Answers | "What happened on the line?" | "What did the university do about it?" |

One call maps to one ticket in the POC. The model permits a future many-to-one relationship
(a follow-up call attached to an existing case) without schema change.

## State machine

```
                    ┌──────────────┐
                    │  AI_HANDLING │◀── created at call start
                    └──┬────────┬──┘
                       │        │
          ┌────────────┘        └──────────────┐
          ▼                                    ▼
   ┌─────────────┐                      ┌────────────┐
   │ AI_RESOLVED │                      │ ESCALATED  │
   └──────┬──────┘                      └─────┬──────┘
          │                                   ▼
          │                          ┌──────────────────┐
          │                          │ QUEUED_FOR_AGENT │
          │                          └────────┬─────────┘
          │                                   ▼
          │                          ┌─────────────────┐
          │                          │ AGENT_ASSIGNED  │
          │                          └────────┬────────┘
          │                                   ▼
          │                          ┌─────────────────┐
          │                          │ AGENT_HANDLING  │
          │                          └────────┬────────┘
          │                                   ▼
          │                            ┌────────────┐
          │                            │  RESOLVED  │
          │                            └─────┬──────┘
          └──────────────┬────────────────────┘
                         ▼
                    ┌─────────┐
                    │ CLOSED  │  (terminal)
                    └─────────┘

   ABANDONED ◀── from any in-flight state (caller hung up)
```

Defined in `packages/types/src/ticket-state-machine.ts`. Any transition not in the table is
rejected with `INVALID_TICKET_TRANSITION`.

Notable rules:
- `AI_HANDLING → RESOLVED` is **rejected**. AI resolution is `AI_RESOLVED`; `RESOLVED` means
  a human resolved it. Conflating them would corrupt containment reporting.
- `CLOSED` is terminal. Nothing reopens it.
- `RESOLVED → AGENT_HANDLING` is permitted, so a supervisor can reopen before closure.

## Status is not settable from the client

There is no API that assigns `status`. The frontend calls intent-revealing operations —
`accept`, `resolve`, `close` — which the backend maps onto a guarded transition.

`TicketService.update` copies fields by explicit allowlist rather than spreading the patch,
so a `status` supplied at runtime is discarded. This was originally a spread, and the
security test caught it: the type signature blocked `status` at compile time while runtime
wrote it through. Both layers now enforce it.

## Event timeline

Every state change emits a normalized event onto an append-only timeline. A representative
escalated case, taken from a live run:

```
CASE_CREATED                 SYSTEM
AI_GREETING                  AI
INTENT_IDENTIFIED            AI
VERIFICATION_REQUIRED        SYSTEM
OTP_SENT                     SYSTEM
AI_RESPONSE                  AI
IDENTITY_VERIFIED            SYSTEM
APPLICATION_LOOKUP           AI
APPLICATION_STATUS_RETURNED  AI
ESCALATION_REQUESTED         AI
ROUTING_STARTED              SYSTEM
QUEUE_ENTERED                SYSTEM
AGENT_ASSIGNED               SYSTEM
AGENT_CONNECTED              AGENT
TICKET_RESOLVED              AGENT
AGENT_DISCONNECTED           AGENT
TICKET_CLOSED                AGENT
```

## Idempotency

Contact-centre providers deliver at-least-once. Each event carries a deterministic key:

```
sha256(uccCallId :: eventType :: discriminator)
```

where `discriminator` is the provider's own event id where one exists. The repository
claims the key with a conditional write; a duplicate delivery returns `false` and is
discarded. `EventService.emit` returns `null` for a duplicate so callers can avoid
double-applying side effects.

Guaranteed by test: duplicate delivery creates no second call, no second ticket, no second
timeline entry and no second agent assignment.
