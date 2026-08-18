# ADR-0006 — Deterministic intent classification for department routing

**Status:** Accepted · **Date:** 2026-08-14

## Context

Escalation must reach the right department. Intent could be classified by the model.

## Decision

Intent classification and the intent-to-department mapping are deterministic rule tables in
`services/ai/src/intent.ts` and `services/routing/src/index.ts`. The model decides what to
say; it does not decide which department owns a case.

## Rationale

Which department handles a scholarship query is a business rule the university owns
(constitution Principle I). A rule table is auditable, free, instant, and does not drift
between model versions. When routing is wrong, the fix is a code change with a test, not a
prompt adjustment with uncertain blast radius.

It also keeps the comparison honest: routing quality is not a function of which model is
behind the assistant.

## Consequences

**Positive.** Routing is deterministic and unit-testable. Model upgrades cannot silently
change which team receives a case.

**Negative.** A larger intent taxonomy would make the rule table unwieldy, and regular
expressions miss phrasings a model would catch.

**Production path.** Replace the rule table with a trained classifier behind the same
`classifyIntent` interface — still owned by UCC, still auditable, still tested. The model
stays out of the routing decision.
