# ADR-0002 — Authorization is server-side, never prompt-based

**Status:** Accepted · **Date:** 2026-08-14

## Context

The AI must access protected student records. The tempting approach is to instruct the
model in its system prompt: "only disclose application status after verification".

## Decision

The model may **request** an action. The UCC backend **decides** whether it is permitted.

Every protected tool re-validates, server-side, on every invocation: caller identity,
tenant, resource ownership, verification state, authorization. The `CallSecurityContext` is
rebuilt from persisted state before every tool call in the Converse loop
(`services/ai/src/index.ts`), never constructed from anything the model said.

`verified` is read from a stored `VerificationSession` bound to that specific call. There is
no code path by which conversation changes it.

## Consequences

The system prompt shapes behaviour, not permissions. If the entire prompt were deleted, or
an attacker convinced the model to ignore it, no protected data would be disclosed — the
tools still deny.

This is verified by test, not asserted. `tests/security/security.test.ts` scripts the model
to call `get_application_status` directly with no verification, and asserts the tool result
contains no protected field. A live prompt-injection attempt against real Bedrock
(`scripts/smoke.ts`, Scenario 3) produced the same outcome: the model called
`request_identity_verification` and the server-side verified flag stayed false.

**Cost.** Every protected tool call performs several reads. At POC scale this is
negligible; at production scale the caller record and verification state would be cached
per contact with a short TTL, invalidated on verification.

## Alternatives rejected

*Prompt-based authorization* — fails to prompt injection, model drift and ordinary model
error. A hallucinated admission decision is an unacceptable institutional risk.

*Authorization stated in the tool description* — the model chooses whether to honour it.
