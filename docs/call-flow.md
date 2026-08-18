# Call flow

## Inbound

```
Caller dials
     │
     ▼
Amazon Connect contact flow
     │  (POST /api/calls/inbound with the provider contact event)
     ▼
CallService.startInbound
     ├─ idempotency check on providerContactId
     ├─ resolve caller from ANI → Caller | null
     ├─ create UccCall            → CALL_STARTED
     └─ create UccTicket          → CASE_CREATED
     │
     ▼
AiOrchestrator.greet               → AI_GREETING
     │
     ▼
┌─── per caller utterance ──────────────────────────────────┐
│  classifyIntent (deterministic)   → INTENT_IDENTIFIED     │
│                                                            │
│  Bedrock Converse loop, max 6 iterations:                  │
│    build CallSecurityContext from PERSISTED state          │
│    model requests tool                                     │
│    ToolExecutor runs it under the authorization gate       │
│    result returned to the model                            │
│    reload ticket (a tool may have transitioned it)         │
│                                                            │
│  → AI_RESPONSE                                             │
└────────────────────────────────────────────────────────────┘
     │
     ├── public question ──▶ search_public_knowledge → KB_RETRIEVAL
     │
     ├── protected question ─▶ request_identity_verification
     │                          → VERIFICATION_REQUIRED, OTP_SENT
     │                        verify_identity
     │                          → IDENTITY_VERIFIED | IDENTITY_FAILED
     │                        get_application_status
     │                          → APPLICATION_LOOKUP
     │                          → APPLICATION_STATUS_RETURNED
     │
     └── needs a human ─────▶ request_human_agent
                                → ESCALATION_REQUESTED
                                → ROUTING_STARTED
                                → QUEUE_ENTERED
                                → AGENT_ASSIGNED
     │
     ▼
Agent accepts                      → AGENT_CONNECTED
Agent resolves                     → TICKET_RESOLVED, AGENT_DISCONNECTED
Call ends                          → CALL_ENDED, TRANSCRIPT_AVAILABLE
                                   → RECORDING_AVAILABLE (live Connect only)
```

## Protected data path

The sequence that matters most:

```
Caller: "What is my application status?"
   │
   ▼
Model requests get_application_status
   │
   ▼
ToolExecutor ── rebuilds CallSecurityContext from the database
   │
   ▼
ApplicationService.getStatusForContact
   │
   ├─ ctx.verified === false ──────────▶ throw VERIFICATION_REQUIRED
   │                                     (no data read, nothing to leak)
   │
   ├─ verified, but 2 applications ────▶ throw AMBIGUOUS_RESOURCE
   │                                     carrying the choices only
   │
   ├─ verified, id supplied ───────────▶ IdentityService.authorizeApplicationAccess
   │                                       ├─ caller identified?
   │                                       ├─ verified on THIS call?
   │                                       ├─ tenant matches?
   │                                       └─ owner or authorised guardian?
   │                                     DENY ▶ throw NOT_AUTHORIZED
   │                                     ALLOW ▶ return ApplicationView
   │
   └─ upstream unavailable ────────────▶ throw UPSTREAM_UNAVAILABLE
                                         model must escalate, never guess
```

Every throw becomes a structured tool error the model reads. The error explains what is
required; it never reveals whether the protected record exists.

## Outbound

```
OutboundService.createDeadlineReminderCampaign
   └─ targets derived from applications with PENDING documents
      (from the system of record, not a hand-written list)
   │
   ▼
runCampaign, per target:
   TelephonyProvider.startOutboundContact   ← Amazon Connect dials
   CallService.startOutbound
      ├─ UccCall (direction OUTBOUND)  → CALL_STARTED
      └─ UccTicket (HIGH, DEADLINE_REMINDER) → CASE_CREATED
   AiOrchestrator.greet                → AI_GREETING
```

The outbound greeting differs: the assistant explains why the university is calling and
confirms it is speaking to the right person before discussing anything specific.

## Escalation and routing

UCC decides the **department** (a business rule it owns). Amazon Connect decides the
**agent** (a contact-centre function it owns).

```
category ──▶ CATEGORY_TO_DEPARTMENT ──▶ Department
                                            │
                                            ▼
                         TelephonyProvider.transferToQueue
                                            │
                                   Amazon Connect queue
                                            │
                                   Connect selects the agent
                                            ▼
                                   AGENT_ASSIGNED in UCC
```

| Category | Department |
|---|---|
| `ADMISSIONS_SUPPORT`, `APPLICATION_STATUS`, `DOCUMENT_SUBMISSION`, `DEADLINE_REMINDER` | Admissions |
| `FEES_AND_PAYMENTS`, `SCHOLARSHIP`, `FINANCIAL_AID` | Financial Aid |
| `TECHNICAL_SUPPORT` | Technical Support |
| `HOSTEL_AND_CAMPUS`, `GENERAL_ENQUIRY` | General |

## Failure paths

| Failure | Behaviour |
|---|---|
| Knowledge base unavailable | `UPSTREAM_UNAVAILABLE` → model escalates. No answer from general knowledge. |
| Application API unavailable | `UPSTREAM_UNAVAILABLE` → model escalates. No fabricated status. |
| No agent available | Ticket stays `QUEUED_FOR_AGENT`; callback offered. |
| Bedrock unavailable | Orchestrator escalates directly, bypassing the model. |
| Duplicate provider event | Discarded at the storage layer. |
