# Contract — UCC voice bridge API

**Consumer:** the Pipecat voice service · **Provider:** UCC API (`apps/ucc-api`)

This is the *only* interface between the voice pipeline and UCC business logic. Both
endpoints exist today in `routes/voice-bridge.ts`; this feature adds authentication and
session binding to them. Their shapes are otherwise unchanged, so the existing text path is
unaffected.

**Breaking change:** both endpoints become authenticated. Any existing unauthenticated
caller stops working. This is intended (FR-027).

---

## Authentication

Every request to both endpoints MUST carry:

| Header | Meaning | Failure |
|---|---|---|
| `Authorization: Bearer <service-token>` | Proves the caller is the voice service | `401` |
| `X-Ucc-Session-Token: <per-call-token>` | Proves this session may act on this case | `401` / `403` |

The service token is a static shared secret from the environment. The session token is
minted per call by UCC and delivered to the pipeline as a `<Stream>` custom parameter (see
[stream-parameters.md](./stream-parameters.md)).

`GET /api/ai/tools` requires the service token only — the catalogue is not case-specific.

---

## `GET /api/ai/tools`

Returns the single tool catalogue. Fetched at session start so the pipeline never holds a
copy (FR-024).

**Request**

```http
GET /api/ai/tools
Authorization: Bearer <service-token>
```

**Response `200`**

```json
{
  "tools": [
    {
      "name": "search_public_knowledge",
      "description": "Search Infinize University public information...",
      "inputSchema": { "json": { "type": "object", "properties": { "...": {} }, "required": [] } }
    }
  ]
}
```

`inputSchema.json` is plain JSON Schema. The pipeline converts it to its own function-schema
type; the conversion is a rename, not a translation, and the catalogue remains the single
definition.

**Errors**

| Status | When |
|---|---|
| `401` | Missing or invalid service token |

---

## `POST /api/calls/{uccCallId}/tool`

Executes one tool through the UCC authorization gate. The gate rebuilds the security context
from persisted state; nothing in this request can influence an authorization decision.

**Request**

```http
POST /api/calls/call_0cd1b2b3/tool
Authorization: Bearer <service-token>
X-Ucc-Session-Token: <per-call-token>
Content-Type: application/json

{
  "name": "get_application_status",
  "input": { "application_id": "APP-2026-001" }
}
```

**Response `200`** — note that a *denial* is also a `200`. A refusal is a legitimate tool
result, not a transport error, and the model must receive it as data so it can relay it.

```json
{
  "ok": false,
  "data": {
    "error": "NOT_VERIFIED",
    "message": "Identity verification is required before application details can be shared. I can send a passcode to the number on file."
  },
  "control": "VERIFICATION_PENDING",
  "escalated": false,
  "ticketStatus": "AI_HANDLING",
  "departmentId": null,
  "assignedAgentId": null
}
```

**Fields**

| Field | Meaning |
|---|---|
| `ok` | Whether the tool succeeded. `false` includes authorization denials |
| `data` | Returned to the model verbatim. MUST contain nothing the caller may not hear |
| `control` | `ESCALATED` \| `CALLBACK_CREATED` \| `VERIFICATION_PENDING` \| `null` |
| `escalated` | Convenience flag; the pipeline uses it to decide whether to end its session |
| `ticketStatus`, `departmentId`, `assignedAgentId` | Case state after the call |

**Errors**

| Status | When | Pipeline behaviour |
|---|---|---|
| `401` | Missing/invalid service token, or missing session token | Refuse; do not retry |
| `403` | Session token valid but bound to a different case, or expired, or its call has ended | Refuse; do not retry |
| `404` | No case for this call id | Surface as a tool failure |
| `400` | Malformed body or unknown tool name | Surface as a tool failure |
| `5xx` | UCC fault | Surface as a tool failure |

**Contract rule for the consumer:** on any non-`200`, the pipeline MUST return an explicit
failure result to the model — never an empty object. An empty result invites the model to
fill the gap with something it invented (FR-008, FR-010).

Required failure shape returned to the model:

```json
{
  "error": "TOOL_UNAVAILABLE",
  "message": "That information is not available right now."
}
```

---

## Invariants the provider guarantees

1. Authorization is decided server-side from persisted state, regardless of request content
   (FR-012).
2. `data` never contains a field the caller is not entitled to hear at that moment.
3. A denial explains the real remediation path, so the model has something true to say and
   no reason to invent a procedure (FR-010).
4. Tool execution is the same code path used by the existing text voice path — one gate, one
   catalogue, one set of business rules.

## Invariants the consumer guarantees

1. `uccCallId` in the path always comes from the bound session, never from model arguments.
2. Tool results are relayed verbatim; never interpreted, cached, softened or substituted.
3. The service token and session token appear in no log line and no error message.
4. Every request is bounded by a timeout (FR-038).
