# Architecture

## Purpose

Determine whether **Amazon Connect + Amazon Bedrock + UCC** is a stronger foundation for the
Infinize Unified Contact Center than **Vapi + Twilio + UCC**.

## The central idea

The incumbent architecture's weakness is not the AI. It is that UCC ends up owning
contact-centre responsibilities it should not own — routing, queueing, agent state,
callbacks — because the underlying platform is a telephony API rather than a contact
centre. Every one of those becomes UCC's code to write, test, scale and operate.

This POC is built on one boundary:

| Concern | Owner |
|---|---|
| Telephony, phone numbers, contact flows, queues, routing profiles, agent presence, transfer, callback, recording | **Amazon Connect** |
| Tenant, caller, identity, verification, authorization, business rules, AI policy, case management, ticket lifecycle, audit | **UCC** |
| Model inference and reasoning | **Amazon Bedrock** |
| Public university information | **Knowledge Base (RAG)** |
| Transactional student/application data | **University APIs — never RAG** |

## System diagram

```
                              CALLER
                                │
                    inbound ────┴──── outbound
                                │
                    ┌───────────▼───────────┐
                    │    AMAZON CONNECT     │  telephony · contact flows · queues
                    │  (TelephonyProvider)  │  routing profiles · agents · recording
                    └───────────┬───────────┘
                                │ normalized contact events
                    ┌───────────▼───────────┐
                    │   UCC CONTROL PLANE   │
                    │  services/events      │  idempotent · append-only
                    └───────┬───────┬───────┘
                            │       │
              ┌─────────────▼─┐   ┌─▼──────────────────────────┐
              │ AI ORCHESTRATOR│   │        UCC POLICY          │
              │ services/ai    │   │  identity · verification   │
              │ Bedrock        │   │  authorization             │
              │ Converse +     │   │  ── THE SECURITY GATE ──   │
              │ tool use       │   └─┬──────────────────────────┘
              └───┬────────┬───┘     │
                  │        │         │ every protected tool call
      ┌───────────▼──┐  ┌──▼─────────▼──────────┐
      │  PUBLIC KB   │  │   UNIVERSITY APIs     │
      │ Titan        │  │ services/applications │
      │ embeddings   │  │ authoritative source  │
      └───────┬──────┘  └───────────┬───────────┘
              │                     │
              └──────────┬──────────┘
                         ▼
                   AI RESPONSE
                         │
               ┌─────────┴─────────┐
               ▼                   ▼
            RESOLVE            ESCALATE
                                   │
                          ┌────────▼────────┐
                          │  UCC ROUTING    │  department resolution (business rule)
                          └────────┬────────┘
                                   ▼
                          Amazon Connect QUEUE   ← Connect owns agent selection
                                   ▼
                                 AGENT
                                   ▼
                              RESOLUTION
                                   ▼
                              UCC TICKET
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
                 Timeline     Transcript      Recording
```

## Module map

```
packages/
  types/      domain model, ticket state machine, error taxonomy, security context
  shared/     structured logging with redaction, ids, idempotency keys, hashing
  config/     environment schema; no secrets in source

services/
  store/          tenant-partitioned document store (DynamoDB + in-memory) + repositories
  events/         normalized event pipeline, idempotency, realtime fan-out
  ticketing/      UccTicket lifecycle, guarded transitions, notes, audit
  calls/          UccCall lifecycle, inbound/outbound, correlation
  identity/       caller resolution, security context, AUTHORIZATION GATE
  verification/   OTP sessions: hashing, expiry, attempt limits, call binding
  applications/   university APIs — protected transactional data
  knowledge/      corpus loading, chunking, Titan embeddings, retrieval
  ai/             Bedrock Converse orchestrator, tool catalogue, tool executor, prompt
  telephony/      TelephonyProvider port + Amazon Connect adapter + simulator
  routing/        department resolution, queue entry, agent assignment, callback
  agents/         agent workspace: accept, note, resolve, close
  recording/      recording metadata + normalized transcript
  outbound/       campaigns
  realtime/       SSE hub

apps/
  ucc-api/    Fastify modular monolith; composition root wires the modules
  ucc-web/    React + TypeScript enterprise console

infrastructure/cdk/   DynamoDB, S3, IAM, SSM, Secrets Manager, CloudWatch
data/                 Infinize University seed tenant + public KB corpus
tests/                unit · integration · e2e · security
```

## Why a modular monolith, not microservices

`services/*` are domain modules with explicit interfaces, composed in one deployable
(`apps/ucc-api/src/bootstrap/container.ts`). Boundaries are enforced in code rather than by
network hops.

At POC scale, splitting these into separate services would add deployment topology,
inter-service auth, distributed tracing and failure modes without changing a single
boundary. The production path is to extract a module behind its existing interface — the
callers do not change. See ADR-0001.

## Correlation model

Every contact is traceable end to end:

```
UccTicket.id
    └─▶ UccTicket.uccCallId ─▶ UccCall.id
             └─▶ UccCall.providerContactId ─▶ Amazon Connect contact
                      ├─▶ UccEvent[] (timeline, by uccCallId / uccTicketId)
                      ├─▶ Transcript (AI + agent segments)
                      ├─▶ Recording (S3 pointer)
                      ├─▶ Agent
                      └─▶ Resolution
```

A single `traceId` is generated at call start and stamped on the call, the ticket, every
event and every log line. `repos.call.byProviderContactId` resolves a Connect contact id to
the UCC case in one read, via a pointer record written at call creation.

## Data model

DynamoDB single table:

```
PK = TENANT#<tenantId>#COL#<collection>
SK = <id>
```

Tenant isolation is **structural**, not a filter: the tenant is part of the partition key,
so a query cannot cross a tenant boundary even if application code forgets to check. This
is why the cross-tenant security tests pass at the repository layer, before any
authorization logic runs.

Idempotency uses a conditional write (`attribute_not_exists(PK)`) on a deterministic event
key `sha256(uccCallId :: type :: discriminator)`, where the discriminator is the provider's
own event id. Redelivery is a no-op at the storage layer rather than something application
code must remember to handle.

## Key decisions

Recorded as ADRs in [`docs/adr/`](./adr/):

- **ADR-0001** — Modular monolith over microservices
- **ADR-0002** — Server-side authorization gate, never prompt-based
- **ADR-0003** — Titan embeddings + cosine retrieval instead of Bedrock Knowledge Bases
- **ADR-0004** — Telephony provider port; Amazon Connect blocked by organisation SCP
- **ADR-0005** — SSE instead of AppSync subscriptions
- **ADR-0006** — Deterministic intent classification for department routing

## Production path at scale

The question applied to every decision: *does this hold at 100 universities, thousands of
agents, millions of calls?*

| Area | POC | Production |
|---|---|---|
| Compute | One Fastify process | Same modules behind Lambda or ECS; extract hot modules independently |
| Persistence | DynamoDB single table | Unchanged — the key design already partitions by tenant |
| Event ingestion | Direct HTTP from contact flow | EventBridge + SQS between Connect and the processor for replay and backpressure |
| Retrieval | Titan embeddings, in-process index | Bedrock Knowledge Base + OpenSearch Serverless |
| Realtime | SSE | AppSync subscriptions or API Gateway WebSockets when clients also mutate |
| Verification | Fixed demo passcode | Random code delivered via Pinpoint/SNS; the lifecycle around it is unchanged |
| Tenancy | Two seeded tenants | Unchanged model; tenant onboarding becomes a control-plane concern |

The parts that would need to change at scale are deployment topology and two managed
service swaps. The domain model, the security boundary and the ownership split do not
change — which is the point of the exercise.
