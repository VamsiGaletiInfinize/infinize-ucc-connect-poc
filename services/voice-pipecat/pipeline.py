"""
Pipeline factory: one function, two topologies.

    cascaded   transport.in -> STT -> user_agg -> LLM -> TTS -> transport.out -> assistant_agg
    s2s        transport.in ->        user_agg -> S2S ->        transport.out -> assistant_agg

`build_processors` returns the ordered processor list and nothing else. The transport, the
serializer, the session binding, the tool bridge and the authorization gate are assembled by
the caller and are identical in both modes — which is what makes the two comparable rather
than merely coexistent (FR-023, constitution Principle XI).

CREDENTIALS ARE NOT UNIFORM ACROSS THESE SERVICES
-------------------------------------------------
Transcribe, Bedrock and Polly build `aioboto3.Session()` with no arguments, so they resolve
through the standard AWS credential chain and honour `AWS_PROFILE`. Nova Sonic does not: it
takes `access_key_id` and `secret_access_key` as *required* keyword arguments. So for the
s2s path we resolve the chain ourselves and hand over the result, rather than asking
operators to keep a second, weaker credential mechanism alive in `.env`.
"""
from __future__ import annotations

from typing import Any

from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair

from config import PipelineConfig
from prompt import as_context_message, as_system_instruction

# Twilio Media Streams is 8 kHz mu-law. Amazon Transcribe accepts 8 kHz or 16 kHz and
# clamps anything else, so matching 8 kHz keeps one transformation out of the latency path.
TWILIO_SAMPLE_RATE = 8000


class CredentialsUnavailable(RuntimeError):
    """The AWS credential chain produced nothing usable."""


def _resolve_aws_credentials(region: str) -> tuple[str, str, str | None]:
    """
    Resolve static credentials from the standard chain for services that cannot use it.

    Deliberately uses the same chain as everything else in this repository, so `AWS_PROFILE`
    keeps working and no access key needs to live in `.env`.
    """
    import boto3  # imported lazily: the cascaded path never needs this

    session = boto3.Session(region_name=region)
    creds = session.get_credentials()
    if creds is None:
        raise CredentialsUnavailable(
            "No AWS credentials found. Nova Sonic requires explicit credentials, so set "
            "AWS_PROFILE (or the standard AWS_* variables) before starting in s2s mode."
        )
    frozen = creds.get_frozen_credentials()
    return frozen.access_key, frozen.secret_key, frozen.token


def build_context(tools: ToolsSchema, cfg: PipelineConfig) -> LLMContext:
    """
    The conversation context.

    In cascaded mode the system prompt is a message here. In s2s it is a constructor
    argument on the model instead — same text, from the same artifact, so a latency
    comparison is not quietly a prompt comparison (research §R4).
    """
    messages = [] if cfg.mode == "s2s" else [as_context_message()]
    return LLMContext(messages=messages, tools=tools)


def build_llm(cfg: PipelineConfig, tools: ToolsSchema) -> Any:
    """The reasoning service for the configured mode. Both derive from LLMService, so the
    tool bridge registers against either without knowing which it has."""
    if cfg.mode == "s2s":
        from pipecat.services.aws.nova_sonic.llm import AWSNovaSonicLLMService

        access_key, secret_key, session_token = _resolve_aws_credentials(cfg.aws_region)
        return AWSNovaSonicLLMService(
            access_key_id=access_key,
            secret_access_key=secret_key,
            session_token=session_token,
            region=cfg.aws_region,
            model=cfg.nova_sonic_model_id,
            voice_id=cfg.nova_sonic_voice,
            system_instruction=as_system_instruction(),
            tools=tools,
        )

    from pipecat.services.aws.llm import AWSBedrockLLMService

    return AWSBedrockLLMService(model=cfg.bedrock_model_id, aws_region=cfg.aws_region)


def build_stt(cfg: PipelineConfig) -> Any:
    from pipecat.services.aws.stt import AWSTranscribeSTTService

    return AWSTranscribeSTTService(region=cfg.aws_region, sample_rate=TWILIO_SAMPLE_RATE)


def build_tts(cfg: PipelineConfig) -> Any:
    from pipecat.services.aws.tts import AWSPollyTTSService

    return AWSPollyTTSService(region=cfg.aws_region, voice_id="Aditi")


def build_processors(
    cfg: PipelineConfig,
    transport: Any,
    llm: Any,
    aggregators: LLMContextAggregatorPair,
) -> list[Any]:
    """
    The ordered processor list for the configured mode.

    Everything passed in is shared between modes. Only the list differs — which is the
    property FR-023 asserts and `tests/test_pipeline.py` checks by identity rather than by
    reading this docstring.
    """
    if cfg.mode == "s2s":
        return [
            transport.input(),
            aggregators.user(),
            llm,
            transport.output(),
            aggregators.assistant(),
        ]

    return [
        transport.input(),
        build_stt(cfg),
        aggregators.user(),
        llm,
        build_tts(cfg),
        transport.output(),
        aggregators.assistant(),
    ]
