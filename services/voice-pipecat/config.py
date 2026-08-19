"""
Configuration for the voice pipeline.

Read once at startup, validated eagerly, and never re-read. An invalid combination stops
the service rather than degrading into a working-but-wrong pipeline (FR-026, FR-030).

WHY FAIL FAST RATHER THAN FALL BACK
-----------------------------------
Silent fallback is how you measure the wrong topology and report it as the right one. If
`UCC_PIPELINE_MODE=s2s` is misspelled and the service quietly serves the cascaded pipeline,
the latency comparison the whole POC exists to produce becomes fiction, and nothing in the
logs says so. Refusing to start is louder and cheaper.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

Mode = Literal["cascaded", "s2s"]

MODES: tuple[str, ...] = ("cascaded", "s2s")
STT_PROVIDERS: tuple[str, ...] = ("aws",)
LLM_PROVIDERS: tuple[str, ...] = ("bedrock",)
TTS_PROVIDERS: tuple[str, ...] = ("aws",)

# v1 never emitted a tool request in testing, which would restrict the assistant to public
# FAQ answers only. Anything that is not nova-2 is refused rather than discovered mid-call.
REQUIRED_S2S_MODEL_FRAGMENT = "nova-2-sonic"


class ConfigError(RuntimeError):
    """Raised when the environment cannot produce a runnable pipeline."""


@dataclass(frozen=True)
class PipelineConfig:
    mode: Mode
    stt_provider: str
    llm_provider: str
    tts_provider: str
    nova_sonic_model_id: str
    nova_sonic_voice: str
    bedrock_model_id: str
    ucc_api_base: str
    service_token: str
    aws_region: str
    log_level: str
    # Twilio credentials are optional: they are only needed if auto hang-up is enabled,
    # and it deliberately is not (an escalation must keep the line open for the transfer).
    twilio_account_sid: str
    twilio_auth_token: str

    @property
    def is_cascaded(self) -> bool:
        return self.mode == "cascaded"


def _one_of(env: dict[str, str], key: str, allowed: tuple[str, ...], default: str) -> str:
    value = env.get(key, default).strip()
    if value not in allowed:
        raise ConfigError(
            f"{key}={value!r} is not supported. Expected one of: {', '.join(allowed)}. "
            "Refusing to start rather than falling back to a different provider."
        )
    return value


def load_config(env: dict[str, str] | None = None) -> PipelineConfig:
    """
    Build the configuration or raise. Never returns a partially valid object.

    `env` is injectable so the validation rules can be tested without mutating the process
    environment.
    """
    e = dict(os.environ if env is None else env)

    mode = _one_of(e, "UCC_PIPELINE_MODE", MODES, "cascaded")

    # The service credential is what proves this process is the voice pipeline. Without it
    # every tool call would be rejected by UCC anyway, so starting is pointless and starting
    # *quietly* is worse — it looks like a working service until the first caller.
    service_token = e.get("UCC_VOICE_SERVICE_TOKEN", "").strip()
    if not service_token:
        raise ConfigError(
            "UCC_VOICE_SERVICE_TOKEN is required. The voice bridge executes privileged "
            "tools and will reject an unauthenticated caller; refusing to start rather "
            "than serving an open channel."
        )

    nova_model = e.get("NOVA_SONIC_MODEL_ID", "amazon.nova-2-sonic-v1:0").strip()
    if mode == "s2s" and REQUIRED_S2S_MODEL_FRAGMENT not in nova_model:
        raise ConfigError(
            f"UCC_PIPELINE_MODE=s2s requires a {REQUIRED_S2S_MODEL_FRAGMENT} model, got "
            f"{nova_model!r}. Earlier Nova Sonic versions do not emit tool requests, which "
            "would silently limit the assistant to public FAQ answers."
        )

    return PipelineConfig(
        mode=mode,  # type: ignore[arg-type]
        stt_provider=_one_of(e, "UCC_STT_PROVIDER", STT_PROVIDERS, "aws"),
        llm_provider=_one_of(e, "UCC_LLM_PROVIDER", LLM_PROVIDERS, "bedrock"),
        tts_provider=_one_of(e, "UCC_TTS_PROVIDER", TTS_PROVIDERS, "aws"),
        nova_sonic_model_id=nova_model,
        nova_sonic_voice=e.get("NOVA_SONIC_VOICE", "tiffany").strip(),
        bedrock_model_id=e.get(
            "BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
        ).strip(),
        ucc_api_base=e.get("UCC_API_BASE", "http://localhost:4000").rstrip("/"),
        service_token=service_token,
        aws_region=e.get("AWS_REGION", "us-east-1").strip(),
        log_level=e.get("LOG_LEVEL", "INFO").strip().upper(),
        twilio_account_sid=e.get("TWILIO_ACCOUNT_SID", "").strip(),
        twilio_auth_token=e.get("TWILIO_AUTH_TOKEN", "").strip(),
    )
