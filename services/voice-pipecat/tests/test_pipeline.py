"""Both topologies must SHARE the transport, serializer and tool bridge - not merely
resemble each other. Asserted by identity, so a copy would fail."""
from pipecat.adapters.schemas.tools_schema import ToolsSchema

from config import load_config
from pipeline import build_context, build_processors

BASE = {"UCC_VOICE_SERVICE_TOKEN": "t"}


class FakeTransport:
    def __init__(self):
        self._in, self._out = object(), object()

    def input(self):
        return self._in

    def output(self):
        return self._out


class FakeAggregators:
    def __init__(self):
        self._u, self._a = object(), object()

    def user(self):
        return self._u

    def assistant(self):
        return self._a


class FakeLLM:
    pass


def _build(mode, monkeypatch):
    cfg = load_config({**BASE, "UCC_PIPELINE_MODE": mode})
    transport, aggs, llm = FakeTransport(), FakeAggregators(), FakeLLM()
    if mode == "cascaded":
        # Constructing the real AWS services would need credentials and a network; the
        # ordering is what this test is about.
        monkeypatch.setattr("pipeline.build_stt", lambda c: "STT")
        monkeypatch.setattr("pipeline.build_tts", lambda c: "TTS")
    return cfg, transport, aggs, llm, build_processors(cfg, transport, llm, aggs)


def test_s2s_has_no_separate_stt_or_tts_stage(monkeypatch):
    _, t, a, llm, procs = _build("s2s", monkeypatch)
    assert procs == [t.input(), a.user(), llm, t.output(), a.assistant()]


def test_cascaded_inserts_stt_and_tts_around_the_model(monkeypatch):
    _, t, a, llm, procs = _build("cascaded", monkeypatch)
    assert procs == [t.input(), "STT", a.user(), llm, "TTS", t.output(), a.assistant()]


def test_both_modes_share_the_same_transport_instance(monkeypatch):
    """FR-023: same transport, not an equivalent one."""
    cfg_s2s = load_config({**BASE, "UCC_PIPELINE_MODE": "s2s"})
    cfg_casc = load_config({**BASE, "UCC_PIPELINE_MODE": "cascaded"})
    monkeypatch.setattr("pipeline.build_stt", lambda c: "STT")
    monkeypatch.setattr("pipeline.build_tts", lambda c: "TTS")

    transport, aggs, llm = FakeTransport(), FakeAggregators(), FakeLLM()
    s2s = build_processors(cfg_s2s, transport, llm, aggs)
    casc = build_processors(cfg_casc, transport, llm, aggs)

    assert s2s[0] is casc[0]                 # transport.input
    assert s2s[-2] is casc[-2]               # transport.output
    assert s2s[-1] is casc[-1]               # assistant aggregator
    assert s2s[2] is casc[3] is llm          # the same model object


def test_s2s_context_carries_no_system_message(monkeypatch):
    """Nova Sonic takes the prompt as a constructor argument instead."""
    cfg = load_config({**BASE, "UCC_PIPELINE_MODE": "s2s"})
    assert build_context(ToolsSchema(standard_tools=[]), cfg).get_messages() == []


def test_cascaded_context_carries_the_system_prompt(monkeypatch):
    cfg = load_config({**BASE, "UCC_PIPELINE_MODE": "cascaded"})
    messages = build_context(ToolsSchema(standard_tools=[]), cfg).get_messages()
    assert len(messages) == 1
    assert messages[0]["role"] == "system"
    assert "Infinize University" in messages[0]["content"]
