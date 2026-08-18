# Testing

```bash
npx vitest run                  # everything — 83 tests
npx vitest run tests/unit
npx vitest run tests/integration
npx vitest run tests/e2e
npx vitest run tests/security

npx tsx scripts/smoke.ts        # live Bedrock end-to-end (needs AWS credentials)
npm run typecheck
```

## Current state

| Suite | Tests | Status |
|---|---|---|
| Unit | 39 | Passing |
| Integration | 19 | Passing |
| E2E scenarios | 12 | Passing |
| Security | 13 | Passing |
| **Total** | **83** | **Passing** |

## Approach

Tests run against the **real** container — real repositories, real ticket state machine,
real authorization gate, real routing. Two things are substituted:

1. **Storage** — `MemoryDocumentStore`, which enforces the same tenant-partitioned key
   discipline as the DynamoDB implementation. A cross-tenant test that passes here is
   testing the same isolation property.
2. **The model** — `ScriptedBedrockClient` returns a deterministic sequence of Converse
   responses including tool-use blocks.

Scripting the model is deliberate. These tests assert *our* behaviour, not a model's word
choice. Crucially, it lets the security suite script the **worst case**: a model that goes
straight for protected data with no verification. A test that relies on the model behaving
well proves nothing about the security boundary.

Live model behaviour is covered separately by `scripts/smoke.ts`, which runs the same flows
against real Bedrock.

## What each suite covers

**Unit** — ticket state machine (every valid path, every rejected one, terminality);
authorization gate (owner, non-owner, unverified, unknown caller, guardian, cross-tenant,
forged context); verification (correct, incorrect, expiry, attempt exhaustion, call
binding, no plaintext persistence); idempotency keys; log redaction.

**Integration** — call and case creation for inbound and outbound; ANI identity resolution;
provider-contact-id correlation; duplicate delivery; escalation to the correct department;
queue transfer delegated to the provider; agent assignment; accept/note/resolve/close;
wrong-agent rejection; callback lifecycle; outbound campaign targeting; application service
verification, ambiguity and failure behaviour.

**E2E** — the nine acceptance scenarios from the spec, plus knowledge-base failure,
application-API failure and full ticket-to-contact traceability.

**Security** — unverified access denial with an explicit check that no protected field
appears in the tool result; wrong-owner and cross-tenant denial; repository-level tenant
isolation; verification not carrying between calls; session replay rejection; exhausted
attempts; ticket status not settable from a patch; invalid transitions rejected; passcode
absent from logs and from every persisted record.

## Three bugs testing found

**Stale ticket in outbound campaigns.** `runCampaign` returned the ticket captured before
the campaign's classification was applied, so callers saw `NORMAL` priority on a case the
database recorded as `HIGH`. Caught by an integration test; fixed at the source.

**Ticket status writable at runtime.** `TicketService.update` spread its patch object, so
`status` was blocked by TypeScript at compile time but written through at run time —
bypassing the state machine entirely. Any route that forwarded a request body would have
exposed it. Caught by a security test; fixed with an explicit field allowlist.

Both were real defects in the implementation, not test artefacts.

## Gaps

- No test runs against real DynamoDB; the in-memory store is a faithful but separate
  implementation.
- No test exercises Amazon Connect, because no instance exists (ADR-0004).
- No frontend component tests — the UI is verified by build and by manual demo.
- No load or latency testing.
- No test of real voice interaction, which is the single largest untested area.

### 3. Supervisor dashboard counted assigned calls as waiting

Found by looking at the screen, not by a test. The "Waiting in Queue" tile counted every
call with status `QUEUED` — but a call keeps that status from queue entry until the agent
accepts, so a call already routed to an agent was counted as waiting. The per-queue table
(counting `QUEUED_FOR_AGENT` tickets) correctly showed zero, and the agent floor showed the
agent `ON CALL`. Three panels, one screen, two different stories.

Fixed by splitting the bucket in `summariseCallLoad()`: `waitingCalls` (no agent yet) versus
`ringingCalls` (assigned, not yet accepted), with the latter surfaced as a hint on both
dashboards.

## Browser verification

`scripts/ui-verify.mjs` drives the console in a real Chromium via Playwright: it visits all
ten routes, screenshots each one full-page, and fails on React errors, console errors,
failed network requests, or a route that renders an empty shell.

```bash
npm start                 # terminal 1
npm run dev:web           # terminal 2
node scripts/ui-verify.mjs ui-shots
```

It requires a seeded call and ticket so the detail pages have something to render; create
one with `POST /api/calls/inbound` first.

**This is what found the supervisor metric bug.** The unit and integration suites were green
and the build was clean, because every layer was individually correct — the defect only
appeared as two panels on one screen disagreeing with each other. A clean build proves the
code compiles, not that the screen tells the truth.
