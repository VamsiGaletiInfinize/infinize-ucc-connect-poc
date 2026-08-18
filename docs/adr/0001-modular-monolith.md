# ADR-0001 — Modular monolith over physical microservices

**Status:** Accepted · **Date:** 2026-08-14

## Context

The target structure lists eight or more domain services. The instinct is to deploy each
one separately.

## Decision

`services/*` are domain modules with explicit TypeScript interfaces, composed into a single
deployable at `apps/ucc-api/src/bootstrap/container.ts`. Boundaries are enforced by module
interfaces and the dependency direction in the composition root, not by network calls.

## Consequences

**Positive.** One deployment, one log stream, one trace. Cross-module calls are typed, so a
boundary violation is a compile error rather than a runtime 500. The POC was built and
tested in hours rather than days.

**Negative.** Modules cannot scale independently, and nothing physically prevents a
developer from importing across a boundary they should not.

**Production path.** Each module is extracted behind its existing interface — callers do
not change. The natural first extraction is `services/ai`, whose latency profile and
scaling characteristics differ most from the rest.

## Alternatives rejected

*Lambda per service* — adds cold starts, inter-service IAM, and distributed tracing to prove
a point about boundaries that interfaces already prove.
