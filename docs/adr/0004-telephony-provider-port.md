# ADR-0004 — Telephony provider port; Amazon Connect blocked by organisation SCP

**Status:** Accepted · **Date:** 2026-08-14
**Severity:** This is the most important operational finding of the POC.

## Context

The POC requires a live Amazon Connect instance for inbound calls, outbound calls, contact
flows, queues, routing profiles, agents, transfer, callback and recording.

Amazon Connect instance creation was attempted four times in `us-east-1`, across **two
separate AWS accounts** — `279078306711` (Dev) and `575838736153` (Test). All four attempts
reached `CREATION_FAILED` with the identical root cause, confirming an organisation-wide
policy rather than an account misconfiguration.

The root cause is an AWS Organizations service control policy:

```
User: arn:aws:sts::279078306711:assumed-role/AWSReservedSSO_ps-AWSINFZFullStackDevs-Dev_.../vamsi.galeti@infinize.ai
is not authorized to perform: iam:CreateServiceLinkedRole
on resource: arn:aws:iam::279078306711:role/aws-service-role/connect.amazonaws.com/AWSServiceRoleForAmazonConnect
with an explicit deny in a service control policy:
arn:aws:organizations::698995614981:policy/o-308lhphlqp/service_control_policy/p-qocf1ngi
```

The same denial was reproduced directly against `iam:CreateServiceLinkedRole` in both
accounts, independent of Connect, which isolates the cause beyond doubt.

Amazon Connect creates `AWSServiceRoleForAmazonConnect` on the caller's behalf during
instance creation. The SCP denies this, so instance creation cannot succeed regardless of
region, alias, or the inbound/outbound flags used. The role does not already exist in the
account, and it cannot be pre-created for the same reason.

## Decision

Introduce a `TelephonyProvider` port (`services/telephony/src/provider.ts`) with two
adapters:

- **`AmazonConnectProvider`** — real Amazon Connect SDK calls
  (`StartOutboundVoiceContact`, `StartTaskContact`, `StopContact`, queue transfer).
- **`SimulatedConnectProvider`** — issues the same provider contact ids and drives the same
  normalized event pipeline, without PSTN audio.

Selection is configuration (`UCC_TELEPHONY=connect|simulated`), not code.

## What this does and does not compromise

**Genuinely exercised, with no simulation:** Amazon Bedrock inference and tool use, Titan
embedding retrieval, identity resolution, verification, the authorization gate, the ticket
state machine, event idempotency, department routing, queue entry, agent assignment,
agent accept/resolve/close, callback lifecycle, outbound campaign case creation, transcript,
supervisor metrics, tenant isolation.

**Not exercised:** PSTN audio, real DTMF, real Connect queue wait behaviour under load,
Contact Lens, actual call recording capture, and the real latency of Connect contact flow
execution.

The UI labels every simulated surface `POC MOCK` and states what a live instance would
provide (see the Recording tab on any ticket).

## Consequences

The Connect integration is real code against the real SDK, not a fiction — but it has not
been executed against a live instance. That is the honest position and it is stated in the
final report rather than papered over.

## Required to unblock

An AWS Organizations administrator must do one of the following. Note this applies to the
organisation (`o-308lhphlqp`), not to a single account — see
[`aws-governance-constraints.md`](../aws-governance-constraints.md) for the full list of
policies encountered:

1. Amend SCP `p-qocf1ngi` to permit `iam:CreateServiceLinkedRole` where
   `iam:AWSServiceName` equals `connect.amazonaws.com`; or
2. Pre-create `AWSServiceRoleForAmazonConnect` using a principal not subject to the SCP; or
3. Provide a different AWS account where Amazon Connect instance creation is permitted.

After that, create the instance, claim a phone number, import the contact flow, then set
`UCC_TELEPHONY=connect` and `CONNECT_INSTANCE_ID`. No application code changes.
