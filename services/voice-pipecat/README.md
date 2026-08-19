# UCC voice pipeline (Pipecat + Amazon Nova Sonic)

An **optional** replacement for Twilio ConversationRelay. Selected with `UCC_VOICE=pipecat`
on the UCC API; with `UCC_VOICE=conversationrelay` (the default) this service is not used
and need not run.

## Why it exists

ConversationRelay does speech-to-text, then UCC runs a Bedrock Converse round-trip, then
Twilio speaks the answer. That is roughly 2–3 seconds per turn. Nova Sonic collapses
listening, reasoning and speaking into one bidirectional stream — measured at **433 ms** to
first audio in `scripts/nova-sonic-spike.ts`, with barge-in handled inside the model.

## What this service does NOT do

It holds no tool logic, no tool schemas of its own, and no authorization.

- Tool catalogue is fetched from `GET /api/ai/tools`
- Every tool call goes to `POST /api/calls/:id/tool`, which rebuilds the security context
  from persisted state and applies the same gate as the text path

So an unverified caller is refused whichever model is asking. Moving the model out of the
UCC process does not move the security boundary with it.

## Run locally

```bash
pip install -r requirements.txt
export UCC_API_BASE=http://host.docker.internal:4000   # or http://localhost:4000
export AWS_REGION=us-east-1                            # credentials from the environment
uvicorn bot:app --host 0.0.0.0 --port 8100
```

Then set on the UCC API and restart it:

```bash
UCC_VOICE=pipecat
PIPECAT_WS_URL=wss://<public-host>/ws
```

Twilio needs a public `wss://` URL, so in development tunnel port 8100 as well as 4000.

## Deployment

Long-lived bidirectional streams mean this cannot run on Lambda: a dying instance drops the
call rather than the next turn being served elsewhere. Run it on Fargate (or equivalent)
behind an ALB with websocket support, and scale on concurrent streams rather than requests
per second.
