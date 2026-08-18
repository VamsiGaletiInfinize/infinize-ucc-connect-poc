# ADR-0005 — Server-Sent Events instead of AppSync subscriptions

**Status:** Accepted · **Date:** 2026-08-14

## Context

The supervisor dashboard and live call console need realtime updates: call status, agent
presence, queue depth, ticket transitions.

## Decision

Realtime is delivered over SSE from `ucc-api` (`GET /api/realtime`), fed by an in-process
hub subscribed to the committed-event stream.

## Rationale

The traffic is strictly one-way, server to browser, with a single consumer type. SSE
delivers that over plain HTTP with automatic browser reconnection, no schema, no client
codegen, and no additional service to operate. AppSync earns its place when clients also
mutate through the same channel, or when subscriptions must fan out across regions and
accounts — neither applies here.

## Consequences

**Positive.** Roughly forty lines of server code and ten of client code. No GraphQL schema
to keep in sync with the domain model as it changes.

**Negative.** Fan-out is per-process. Multiple API instances behind a load balancer would
each serve only their own subscribers.

**Production path.** AppSync Events, or API Gateway WebSockets with a DynamoDB connection
table, once the API runs more than one instance. The client contract is a stream of
`{type, event}` frames — deliberately transport-shaped rather than SSE-shaped — so the swap
does not reach into the pages.

List screens also poll on a short interval, so a client that misses a frame still converges
rather than showing stale state indefinitely.
