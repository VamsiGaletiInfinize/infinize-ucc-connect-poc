"""
UCC voice pipeline: Twilio Media Streams -> STT/LLM/TTS or speech-to-speech -> UCC tools.

RESPONSIBILITY BOUNDARY
-----------------------
This service owns the real-time voice leg and nothing else:

    owns          audio transport, turn-taking, barge-in, inference orchestration
    does NOT own  identity, verification, authorization, tool logic, queueing, agent
                  selection, tickets, persistence

Every tool the model calls is executed by the UCC API, which rebuilds the security context
from persisted state. An unverified caller is refused whichever model asks (ADR-0002).
Moving the model out of the UCC process must not move the security boundary with it
(constitution Principle X).
"""
from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket
from fastapi.responses import JSONResponse
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import EndFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)

from config import ConfigError, PipelineConfig, load_config
from observability import CallLogger, MetricsObserver, configure_logging
from pipeline import TWILIO_SAMPLE_RATE, build_context, build_llm, build_processors
from tools import ToolBridge, to_tools_schema
from ucc_client import UccAuthError, UccClient

# Nova Sonic emits 24 kHz; the serializer resamples down to Twilio's 8 kHz mu-law.
AUDIO_OUT_SAMPLE_RATE = 24000

# Close codes for a refused stream. 1008 is "policy violation", which is what this is: the
# stream did not present what it needs to be governed.
WS_POLICY_VIOLATION = 1008

logger = logging.getLogger("ucc-voice")

_config: PipelineConfig | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Validate everything that can be validated before a caller is on the line.

    Configuration errors and a mismatched service credential both surface here rather than
    on the first tool call of the first real caller (FR-026, FR-030, FR-050).
    """
    global _config
    _config = load_config()
    configure_logging(_config.log_level)

    probe = UccClient(_config.ucc_api_base, _config.service_token)
    try:
        await probe.verify_credentials()
        logger.info(
            "voice service ready",
            extra={"ucc": {"mode": _config.mode, "uccApiBase": _config.ucc_api_base}},
        )
    except UccAuthError:
        # Refuse to start: a service that cannot authenticate will fail every tool call,
        # and failing at startup is far cheaper to diagnose than failing mid-conversation.
        raise
    except Exception as exc:
        # UCC being merely unreachable at boot is not fatal — it may still be starting —
        # but it is worth saying loudly, because the symptom later is a silent call.
        logger.warning(
            "could not reach UCC at startup; credentials unverified",
            extra={"ucc": {"reason": type(exc).__name__}},
        )
    finally:
        await probe.close()

    yield


app = FastAPI(title="UCC voice pipeline", lifespan=lifespan)


@app.get("/health")
async def health() -> JSONResponse:
    cfg = _config
    if cfg is None:
        return JSONResponse({"status": "starting"}, status_code=503)
    return JSONResponse(
        {
            "status": "ok",
            "mode": cfg.mode,
            "model": cfg.nova_sonic_model_id if cfg.mode == "s2s" else cfg.bedrock_model_id,
            "stt": cfg.stt_provider if cfg.is_cascaded else None,
            "tts": cfg.tts_provider if cfg.is_cascaded else None,
            "uccApiBase": cfg.ucc_api_base,
            "region": cfg.aws_region,
        }
    )


def bind_session(start_frame: dict[str, Any]) -> tuple[str, str, str, str, str]:
    """
    Extract and validate the identifiers a governed session requires.

    Raises ValueError if either required parameter is missing. A stream with no case id
    cannot be traced, gated or ticketed, and one with no session token cannot execute a
    tool — running either would be an ungoverned conversation with a real caller
    (FR-006, FR-028).
    """
    start = start_frame.get("start") or {}
    custom = start.get("customParameters") or {}

    ucc_call_id = (custom.get("uccCallId") or "").strip()
    session_token = (custom.get("sessionToken") or "").strip()

    missing = [
        name
        for name, value in (("uccCallId", ucc_call_id), ("sessionToken", session_token))
        if not value
    ]
    if missing:
        raise ValueError(f"stream start is missing: {', '.join(missing)}")

    return (
        start.get("streamSid", ""),
        start.get("callSid", ""),
        ucc_call_id,
        (custom.get("tenantId") or "").strip(),
        session_token,
    )


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()

    cfg = _config
    if cfg is None:  # pragma: no cover - lifespan always runs first in practice
        await websocket.close(code=WS_POLICY_VIOLATION)
        return

    # Twilio sends two preamble frames before any audio: 'connected', then 'start'.
    await websocket.receive_text()
    start_frame = json.loads(await websocket.receive_text())

    try:
        stream_sid, call_sid, ucc_call_id, tenant_id, session_token = bind_session(start_frame)
    except (ValueError, json.JSONDecodeError) as exc:
        logger.error(
            "refusing ungoverned voice session",
            extra={"ucc": {"reason": str(exc), "callSid": (start_frame.get("start") or {}).get("callSid")}},
        )
        await websocket.close(code=WS_POLICY_VIOLATION)
        return

    log = CallLogger(ucc_call_id, cfg.mode)
    log.info("voice session start", callSid=call_sid, tenantId=tenant_id)

    ucc = UccClient(cfg.ucc_api_base, cfg.service_token, session_token, logger=log)
    bridge = ToolBridge(ucc, ucc_call_id, log)

    try:
        # The catalogue is fetched, never copied, so it cannot drift from UCC's definition.
        # If it cannot be fetched there are no tools, and an assistant that can only talk —
        # unable to retrieve, verify or escalate — is exactly the ungoverned conversation
        # this service refuses to hold (FR-046).
        try:
            specs = await ucc.tool_specs()
        except Exception as exc:
            log.error("tool catalogue unavailable; refusing session", reason=type(exc).__name__)
            await websocket.close(code=WS_POLICY_VIOLATION)
            return

        log.info("tool catalogue loaded", toolCount=len(specs))
        tools = to_tools_schema(specs)

        serializer = TwilioFrameSerializer(
            stream_sid=stream_sid,
            call_sid=call_sid,
            account_sid=cfg.twilio_account_sid or None,
            auth_token=cfg.twilio_auth_token or None,
            # UCC decides when a call ends, and an escalation must keep the line open for
            # the transfer. Auto hang-up would drop the caller mid-handoff — this is the
            # failure that cost a live call once already.
            params=TwilioFrameSerializer.InputParams(auto_hang_up=False),
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

        llm = build_llm(cfg, tools)
        bridge.register_all(llm, specs)

        context = build_context(tools, cfg)
        aggregators = LLMContextAggregatorPair(context)

        task = PipelineTask(
            Pipeline(build_processors(cfg, transport, llm, aggregators)),
            params=PipelineParams(
                audio_in_sample_rate=TWILIO_SAMPLE_RATE,
                audio_out_sample_rate=AUDIO_OUT_SAMPLE_RATE,
                allow_interruptions=True,
                enable_metrics=True,
            ),
            observers=[MetricsObserver(log, cfg.mode)],
        )

        @transport.event_handler("on_client_disconnected")
        async def on_disconnected(_transport, _client):
            log.info("caller disconnected")
            await task.queue_frames([EndFrame()])

        await PipelineRunner(handle_sigint=False).run(task)

        # On escalation the call is still live and the TwiML action URL performs the
        # transfer. Ending it here would drop the caller mid-handoff.
        log.info("voice session ended", escalated=bridge.escalated)
        if not bridge.escalated:
            await ucc.end_call(ucc_call_id, "COMPLETED")

    except Exception:
        log.exception("voice session failed")
        await ucc.end_call(ucc_call_id, "FAILED")
    finally:
        await ucc.close()
