# Implementation Plan — Infinize UCC Connect POC

**Spec:** `./spec.md` · **Constitution:** `.specify/memory/constitution.md` v1.0.0

## Technical Context

| Area | Decision |
|---|---|
| Language | TypeScript (Node 24) across backend, frontend, infra |
| Backend | Fastify modular monolith (`apps/ucc-api`), domain modules under `services/` |
| Frontend | React 18 + TypeScript + Vite (`apps/ucc-web`) |
| Persistence | DynamoDB single-table (`UccTable`) + pluggable in-memory repo for tests |
| AI | Amazon Bedrock Converse API with tool use, Claude Sonnet 4.5 via `us.` inference profile |
| Retrieval | Amazon Titan Embeddings v2 + cosine similarity index persisted to S3 |
| Telephony | Amazon Connect via a `TelephonyProvider` port; simulator adapter for blocked environments |
| Realtime | Server-Sent Events from `ucc-api` |
| Infra | AWS CDK v2 (`infrastructure/cdk`) |
| Tests | Vitest — unit, integration, E2E scenario, security suites |

## Architecture

```
Caller ──▶ Amazon Connect ──▶ Event Ingestion ──▶ Normalizer ──▶ UCC Event Processor
                                                                      │
                            ┌─────────────────────────────────────────┼──────────────┐
                            ▼                                         ▼              ▼
                     AI Orchestrator                            UCC Policy       Timeline
                     (Bedrock + tools)                 (identity/verify/authz)   + Realtime
                            │                                         │
                 ┌──────────┴──────────┐                              │
                 ▼                     ▼                              ▼
          Public KB (RAG)      University APIs  ◀── server-side authorization gate
                 │                     │
                 └────────┬────────────┘
                          ▼
                   Resolve ── or ── Escalate ──▶ Routing ──▶ Connect Queue ──▶ Agent
                          │                                                      │
                          └──────────────────▶ UccCall + UccTicket ◀─────────────┘
                                                     │
                                    Timeline · Transcript · Recording · Audit
```

## Key Design Decisions

**D1 — Modular monolith, not microservices.** `services/*` are domain modules with explicit
interfaces, imported by one deployable. Boundaries are enforced in code, not by network
hops. Production path: extract a module to its own Lambda without changing callers.

**D2 — Telephony provider port.** `TelephonyProvider` abstracts Connect. `AmazonConnectProvider`
issues real SDK calls; `SimulatedConnectProvider` emits byte-identical normalized events.
Rationale: the target AWS account's SCP blocks Connect instance creation (see ADR-0004);
the abstraction keeps the Connect integration real and switchable rather than fictional.

**D3 — Embeddings retrieval instead of Bedrock Knowledge Bases.** Bedrock KB requires
OpenSearch Serverless (slow to provision, costly at POC scale). We use real Titan v2
embeddings with cosine similarity over a persisted index. Production path: swap the
`Retriever` port for Bedrock KB + OpenSearch. Retrieval remains genuinely vector-based.

**D4 — SSE instead of AppSync subscriptions.** Realtime is delivered over SSE from the API.
AppSync adds a GraphQL layer and client codegen that buys nothing for a single-consumer
dashboard at POC scale. Production path documented in ADR-0005.

**D5 — Authorization gate is a distinct module.** Every protected tool call passes through
`services/identity` + `services/verification` policy checks that read persisted state —
never model-asserted state. The AI's claims are treated as untrusted input.

**D6 — DynamoDB single-table.** `PK`/`SK` with GSIs for tenant-scoped listing and provider
contact-id lookup. Idempotency via conditional writes on a deterministic event key.

## Phases

1. Foundation — workspace, types, config, logging
2. Domain — UccCall, UccTicket, state machine, events, idempotency
3. Persistence — DynamoDB repositories + in-memory
4. Data — Infinize University seed corpus
5. Identity / Verification / Authorization
6. Application APIs
7. Knowledge Base + retrieval
8. AI orchestrator + tools
9. Telephony provider + Connect adapter + event ingestion
10. Routing, escalation, agent assignment, callback, outbound
11. Recording, transcript
12. Realtime
13. Frontend
14. CDK + deploy
15. Tests
16. Docs, ADRs, comparison, demo hardening
