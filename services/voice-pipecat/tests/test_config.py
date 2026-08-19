"""Configuration must fail loudly, never fall back quietly."""
import pytest

from config import ConfigError, load_config

BASE = {"UCC_VOICE_SERVICE_TOKEN": "s3cret-for-tests"}


def test_defaults_to_cascaded():
    cfg = load_config(BASE)
    assert cfg.mode == "cascaded"
    assert cfg.is_cascaded


def test_missing_service_token_refuses_to_start():
    with pytest.raises(ConfigError, match="UCC_VOICE_SERVICE_TOKEN"):
        load_config({})


def test_blank_service_token_refuses_to_start():
    with pytest.raises(ConfigError, match="UCC_VOICE_SERVICE_TOKEN"):
        load_config({"UCC_VOICE_SERVICE_TOKEN": "   "})


def test_unknown_mode_refuses_rather_than_defaulting():
    with pytest.raises(ConfigError) as exc:
        load_config({**BASE, "UCC_PIPELINE_MODE": "casacded"})
    # The message must name the supported values; a typo should be self-diagnosing.
    assert "cascaded" in str(exc.value) and "s2s" in str(exc.value)


@pytest.mark.parametrize(
    "key,allowed",
    [("UCC_STT_PROVIDER", "aws"), ("UCC_LLM_PROVIDER", "bedrock"), ("UCC_TTS_PROVIDER", "aws")],
)
def test_unknown_provider_refuses(key, allowed):
    assert load_config({**BASE, key: allowed})
    with pytest.raises(ConfigError, match=key):
        load_config({**BASE, key: "definitely-not-a-provider"})


def test_s2s_rejects_nova_sonic_v1():
    """v1 never emitted a tool request, which would silently limit us to public FAQ."""
    with pytest.raises(ConfigError, match="nova-2-sonic"):
        load_config({
            **BASE,
            "UCC_PIPELINE_MODE": "s2s",
            "NOVA_SONIC_MODEL_ID": "amazon.nova-sonic-v1:0",
        })


def test_s2s_accepts_nova_2():
    cfg = load_config({**BASE, "UCC_PIPELINE_MODE": "s2s"})
    assert cfg.mode == "s2s"
    assert "nova-2-sonic" in cfg.nova_sonic_model_id


def test_api_base_trailing_slash_is_normalised():
    cfg = load_config({**BASE, "UCC_API_BASE": "http://localhost:4000/"})
    assert cfg.ucc_api_base == "http://localhost:4000"
