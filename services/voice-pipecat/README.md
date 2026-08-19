# UCC voice pipeline (Pipecat)

The real-time voice leg. Twilio Media Streams in, speech out, with every tool call executed
by the UCC API rather than here.

Selected with `UCC_VOICE=pipecat` on the UCC API. With `UCC_VOICE=conversationrelay` (the
default) this service is not used and need not run.

Spec, plan and tasks: [`specs/002-twilio-pipecat-voice/`](../../specs/002-twilio-pipecat-voice/).

## Two topologies, one switch

`UCC_PIPELINE_MODE` selects how the voice leg is built. Everything either side of the
processor list — transport, serializer, session binding, tool bridge, authorization gate —
is shared, which is what makes the two comparable rather than merely coexistent.

```
cascaded   transport.in → Transcribe → user_agg → Bedrock → Polly → transport.out → assistant_agg
s2s        transport.in →              user_agg → Nova Sonic →      transport.out → assistant_agg
```

`cascaded` is swappable stage by stage and debuggable per stage. `s2s` collapses listening,
reasoning and speaking into one bidirectional stream — measured at 433 ms to first audio in
[`scripts/nova-sonic-spike.ts`](../../scripts/nova-sonic-spike.ts), with barge-in handled
inside the model. Which trade is right is the question this POC exists to answer, so both
are built and both are measured (constitution Principle XI).

## What this service does NOT do

It holds no tool logic, no tool schemas of its own, and no authorization.

- The tool catalogue is fetched from `GET /api/ai/tools`
- Every tool call goes to `POST /api/calls/:id/tool`, which rebuilds the security context
  from persisted state and applies the same gate as the text path

So an unverified caller is refused whichever model is asking. Moving the model out of the
UCC process does not move the security boundary with it (ADR-0002, constitution Principle X).

## Requirements

**Python 3.12 is a hard floor**, pinned in `.python-version`. The Nova Sonic dependency
(`aws_sdk_bedrock_runtime`) is gated on `python_version >= "3.12"`, and newer interpreters
are ahead of what the native dependencies support.

Note the dependency extras in `requirements.txt`: `aws-nova-sonic` is **separate** from
`aws`. With only `[aws]`, importing the Nova Sonic service fails at runtime with
`No module named 'aws_sdk_bedrock_runtime'`. There is deliberately no `twilio` extra —
pipecat-ai 1.0.0 does not define one, and asking for it is silently ignored.

AWS credentials resolve through the standard chain, so `AWS_PROFILE` works exactly as it
does elsewhere in this repository. No keys belong in `.env`.

## Run locally

```bash
uv venv .venv --python 3.12
uv pip install --python .venv/Scripts/python.exe -r requirements.txt

export UCC_API_BASE=http://localhost:4000
export UCC_VOICE_SERVICE_TOKEN=<same value as the UCC API>
export UCC_PIPELINE_MODE=cascaded          # or s2s
export AWS_REGION=us-east-1

.venv/Scripts/uvicorn bot:app --host 0.0.0.0 --port 8100
```

Then on the UCC API:

```bash
UCC_VOICE=pipecat
PIPECAT_WS_URL=wss://<public-host>/ws
```

Twilio needs a public `wss://` URL, so in development tunnel port 8100 as well as 4000.
Full setup and the nine validation scenarios:
[`quickstart.md`](../../specs/002-twilio-pipecat-voice/quickstart.md).

## Tests

```bash
.venv/Scripts/python.exe -m pytest -q
```

## Deployment

Long-lived bidirectional streams mean this cannot run on Lambda: a dying instance drops the
call rather than the next turn being served elsewhere. Run it on Fargate (or equivalent)
behind an ALB with websocket support, and scale on concurrent streams rather than requests
per second.

## Status

Phase 1 (installable) complete and verified. Later phases are tracked in
[`tasks.md`](../../specs/002-twilio-pipecat-voice/tasks.md); nothing here is described as
working until it has been executed (constitution Principle VII).
