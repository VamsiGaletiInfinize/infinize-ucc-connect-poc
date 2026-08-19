# Contract — media stream parameters and session handshake

**Producer:** UCC API TwiML (`routes/twilio.ts`) · **Transport:** Twilio · **Consumer:** the
Pipecat voice service

How a media stream is bound to a UCC case and authorised, without adding a new endpoint or
handshake.

---

## Producer: TwiML emitted on call answer

```xml
<Response>
  <Say voice="Polly.Aditi">Thank you for calling Infinize University.</Say>
  <Connect action="https://{public-base}/twilio/voice/handoff">
    <Stream url="wss://{pipecat-host}/ws">
      <Parameter name="uccCallId"     value="call_0cd1b2b3"/>
      <Parameter name="tenantId"      value="infinize-university"/>
      <Parameter name="sessionToken"  value="{minted per call}"/>
    </Stream>
  </Connect>
</Response>
```

Three things are load-bearing here:

- **`<Say>` precedes `<Connect>`.** The greeting is spoken while the stream is still being
  established, so the caller never hears silence on answer and no opening utterance is lost
  (FR-001, SC-001).
- **`action` is unchanged** from the existing path. Escalation, ticketing and routing behave
  identically regardless of which pipeline carried the audio.
- **`sessionToken` is minted here**, at the same moment the case id is known. It rides the
  same channel as the ids it authorises — no extra round trip.

---

## Transport: what Twilio delivers

Twilio sends two frames before any audio. The consumer MUST read both before constructing a
pipeline.

```json
{ "event": "connected", "protocol": "Call", "version": "1.0.0" }
```

```json
{
  "event": "start",
  "start": {
    "streamSid": "MZ...",
    "callSid": "CA...",
    "customParameters": {
      "uccCallId": "call_0cd1b2b3",
      "tenantId": "infinize-university",
      "sessionToken": "..."
    }
  }
}
```

Audio thereafter is 8 kHz μ-law, base64-encoded, in `media` frames. The framework's Twilio
serializer handles encoding, decoding and resampling; this feature does not touch raw media.

---

## Consumer: binding rules

On the `start` frame the voice service MUST:

1. Read `uccCallId`, `tenantId` and `sessionToken` from `customParameters`.
2. **Refuse the session** — close the socket with code `1008`, run no pipeline, execute no
   tool — if `uccCallId` is absent (FR-006) or `sessionToken` is absent (FR-028).
3. Bind all three to the session for its lifetime. They are never re-read, never overwritten,
   and never taken from any later frame.
4. Log the session open with `uccCallId` as correlation id — and never log `sessionToken`.

**Refusing is the required behaviour, not a defensive nicety.** A stream with no case id
cannot be traced, gated or ticketed; running it would be an ungoverned conversation with a
caller.

---

## Session close

| Cause | Consumer action | UCC call ended by |
|---|---|---|
| Caller hangs up | End the pipeline, end the UCC call with `COMPLETED` | the voice service |
| Tool returned `escalated` | End the pipeline; **do not** end the UCC call | the TwiML `action` URL |
| Pipeline failure | Speak a safe sentence, end with `FAILED` | the voice service |

The escalation row is the one that has already gone wrong in production conditions: ending
the call there would drop the caller mid-handoff, and leaving the session open strands them
listening to an assistant that thinks it has transferred them. Auto hang-up in the serializer
MUST stay disabled for this reason.

---

## Security notes, stated rather than implied

- The session token transits Twilio inside the TwiML response and returns in the stream
  `start` frame. Anyone able to observe either can impersonate **that one session, for that
  one call, until the token expires**. Acceptable over TLS for a POC with a short expiry;
  a production design would exchange a nonce for a token over a direct UCC↔pipeline channel.
  This is recorded in `docs/security.md`, not left as a code comment.
- Custom parameters are attacker-visible in the sense above, so the token grants only case
  scope. It carries no verification state and no entitlement — verification remains
  server-side and unchanged (Principle III).
- The `wss://` URL must be reachable by Twilio. In development that means a second tunnel
  alongside the UCC API's.
