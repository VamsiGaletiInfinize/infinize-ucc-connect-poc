"""
UCC voice pipeline: Twilio Media Streams -> Amazon Nova Sonic -> UCC tools -> caller.

RESPONSIBILITY BOUNDARY
-----------------------
This service owns the real-time voice leg and nothing else:

    owns          audio transport, turn-taking, barge-in, speech-to-speech inference
    does NOT own  identity, verification, authorization, tool logic, queueing, agent
                  selection, tickets, persistence

Every tool the model calls is executed by the UCC API, which rebuilds the security context
from persisted state. An unverified caller is refused whichever model asks (ADR-0002).
Moving the model out of the UCC process must not move the security boundary with it.

WHY NOVA SONIC
--------------
ConversationRelay costs a speech-to-text hop, a Bedrock Converse round-trip and a
text-to-speech hop - roughly 2-3s per turn. Nova Sonic does all three in one bidirectional
stream, measured at 433ms to first audio. Version 2 is required: v1 never emitted a tool
request in testing, which would restrict it to public FAQ answers only.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

from fastapi import FastAPI, WebSocket
from fastapi.responses import JSONResponse

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import EndFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.services.aws_nova_sonic.aws import AWSNovaSonicLLMService
from pipecat.transports.network.fastapi_websocket import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)

from ucc_client import UccClient

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("ucc-voice")

UCC_API_BASE = os.getenv("UCC_API_BASE", "http://localhost:4000")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
# v2 deliberately: v1 does not emit tool requests, which would limit us to public FAQ.
NOVA_MODEL = os.getenv("NOVA_SONIC_MODEL_ID", "amazon.nova-2-sonic-v1:0")
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")

app = FastAPI(title="UCC voice pipeline")


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "model": NOVA_MODEL,
            "uccApiBase": UCC_API_BASE,
            "region": AWS_REGION,
        }
    )


SYSTEM_PROMPT = """You are the Infinize University contact centre assistant, speaking on a phone call.

Keep replies short and natural - one or two sentences. This is speech, not a document.

You know nothing about any caller's application, fees or admission status except what the
tools return. Never guess, never infer, and never repeat a value a caller supplies as if you
had confirmed it.

Use search_public_knowledge for general questions about admissions, programmes, documents,
deadlines, fees, scholarships, hostel and campus life.

For anything specific to one person, call the relevant tool. If a tool tells you identity
verification is required, say so plainly and offer to send a passcode - do not invent your
own verification questions.

If the caller asks for a human, or you cannot help, call request_human_agent."""


def _to_function_schema(spec: dict[str, Any]) -> FunctionSchema:
    """
    Convert a UCC tool spec into Pipecat's schema.

    UCC serves Bedrock Converse shapes (inputSchema.json), which are plain JSON Schema, so
    this is a rename rather than a translation. Keeping the conversion here means the
    catalogue still has exactly one definition, on the UCC side.
    """
    json_schema = spec.get("inputSchema", {}).get("json", {}) or {}
    return FunctionSchema(
        name=spec["name"],
        description=spec.get("description", ""),
        properties=json_schema.get("properties", {}) or {},
        required=json_schema.get("required", []) or [],
    )


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    ucc = UccClient(UCC_API_BASE)

    try:
        # Twilio sends two preamble frames before audio: 'connected' then 'start'.
        await websocket.receive_text()
        start_raw = await websocket.receive_text()
        start = json.loads(start_raw)

        stream_sid = start["start"]["streamSid"]
        call_sid = start["start"]["callSid"]
        custom = start["start"].get("customParameters", {}) or {}
        ucc_call_id = custom.get("uccCallId")

        if not ucc_call_id:
            # Without the case id nothing can be traced, gated or ticketed. Refuse rather
            # than run an ungoverned conversation.
            logger.error("No uccCallId on stream start for call %s; closing", call_sid)
            await websocket.close(code=1008)
            return

        logger.info("Voice session start call=%s uccCall=%s", call_sid, ucc_call_id)

        serializer = TwilioFrameSerializer(
            stream_sid=stream_sid,
            call_sid=call_sid,
            account_sid=TWILIO_ACCOUNT_SID,
            auth_token=TWILIO_AUTH_TOKEN,
            # UCC decides when a call ends, and an escalation must keep the line open for
            # the transfer. Auto hang-up would drop the caller mid-handoff.
            auto_hang_up=False,
        )

        transport = FastAPIWebsocketTransport(
            websocket=websocket,
            params=FastAPIWebsocketParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                add_wav_header=False,
                vad_analyzer=SileroVADAnalyzer(),
                serializer=serializer,
            ),
        )

        llm = AWSNovaSonicLLMService(
            region=AWS_REGION,
            model=NOVA_MODEL,
            voice_id=os.getenv("NOVA_SONIC_VOICE", "tiffany"),
        )

        # --- tools: fetched from UCC, executed by UCC -----------------------
        specs = await ucc.tool_specs()
        logger.info("Loaded %d tool specs from UCC", len(specs))

        escalated = {"value": False}

        def make_handler(tool_name: str):
            async def handler(params):  # Pipecat FunctionCallParams
                args = params.arguments or {}
                logger.info("tool -> %s %s", tool_name, args)
                res = await ucc.execute_tool(ucc_call_id, tool_name, args)

                if res.get("escalated"):
                    escalated["value"] = True

                # The model receives exactly what the gate returned. A denial is data, not
                # an error to be smoothed over.
                await params.result_callback(res.get("data", {}))

            return handler

        for spec in specs:
            llm.register_function(spec["name"], make_handler(spec["name"]))

        tools = ToolsSchema(standard_tools=[_to_function_schema(s) for s in specs])
        context = OpenAILLMContext(
            messages=[{"role": "system", "content": SYSTEM_PROMPT}],
            tools=tools,
        )
        context_aggregator = llm.create_context_aggregator(context)

        pipeline = Pipeline(
            [
                transport.input(),
                context_aggregator.user(),
                llm,
                transport.output(),
                context_aggregator.assistant(),
            ]
        )

        task = PipelineTask(
            pipeline,
            params=PipelineParams(
                audio_in_sample_rate=8000,    # Twilio Media Streams is 8kHz mu-law
                audio_out_sample_rate=24000,  # Nova Sonic emits 24kHz
                allow_interruptions=True,
            ),
        )

        @transport.event_handler("on_client_disconnected")
        async def on_disconnected(_transport, _client):
            logger.info("Caller disconnected uccCall=%s", ucc_call_id)
            await task.queue_frames([EndFrame()])

        await PipelineRunner(handle_sigint=False).run(task)

        # The TwiML <Connect> action URL performs the actual transfer; UCC already knows
        # the ticket is escalated because the tool call went through it.
        logger.info("Session ended uccCall=%s escalated=%s", ucc_call_id, escalated["value"])
        if not escalated["value"]:
            await ucc.end_call(ucc_call_id)

    except Exception:
        logger.exception("Voice session failed")
    finally:
        await ucc.close()
