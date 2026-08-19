"""The tool layer converts and relays. It must not interpret."""
import pytest

from tools import ToolBridge, to_function_schema, to_tools_schema

SPEC = {
    "name": "get_application_status",
    "description": "Get the full status of one application.",
    "inputSchema": {"json": {
        "type": "object",
        "properties": {"application_id": {"type": "string"}},
        "required": ["application_id"],
    }},
}


class FakeClient:
    def __init__(self, result):
        self.result = result
        self.calls = []

    async def execute_tool(self, ucc_call_id, name, arguments):
        self.calls.append((ucc_call_id, name, arguments))
        return self.result


class FakeParams:
    def __init__(self, arguments):
        self.arguments = arguments
        self.result = None

    async def result_callback(self, data):
        self.result = data


class NullLogger:
    def info(self, *a, **k): pass
    def error(self, *a, **k): pass


def test_schema_conversion_is_a_rename_not_a_translation():
    schema = to_function_schema(SPEC)
    assert schema.name == "get_application_status"
    assert schema.properties == {"application_id": {"type": "string"}}
    assert schema.required == ["application_id"]


def test_schema_conversion_tolerates_a_tool_with_no_arguments():
    schema = to_function_schema({"name": "get_caller_profile", "inputSchema": {"json": {"type": "object", "properties": {}}}})
    assert schema.properties == {}
    assert schema.required == []


def test_tools_schema_carries_every_tool():
    assert len(to_tools_schema([SPEC, SPEC]).standard_tools) == 2


async def test_denial_is_relayed_verbatim_not_softened():
    """A refusal is data the assistant must speak, not an error to smooth over."""
    denial = {"ok": False, "data": {"error": "NOT_VERIFIED", "message": "Verification required."}, "escalated": False}
    client = FakeClient(denial)
    bridge = ToolBridge(client, "call_1", NullLogger())
    params = FakeParams({"application_id": "APP-1"})

    await bridge.handler_for("get_application_status")(params)

    assert params.result == denial["data"]
    assert bridge.escalated is False


async def test_call_id_comes_from_the_session_not_the_model():
    """A model must not be able to choose which case it operates on."""
    client = FakeClient({"ok": True, "data": {}})
    bridge = ToolBridge(client, "call_bound", NullLogger())

    await bridge.handler_for("get_caller_profile")(FakeParams({"uccCallId": "call_someone_else"}))

    assert client.calls[0][0] == "call_bound"


async def test_escalation_flag_is_set_from_the_tool_result():
    client = FakeClient({"ok": True, "data": {}, "escalated": True})
    bridge = ToolBridge(client, "call_1", NullLogger())
    await bridge.handler_for("request_human_agent")(FakeParams({}))
    assert bridge.escalated is True


async def test_missing_data_key_yields_empty_object_not_none():
    client = FakeClient({"ok": True})
    bridge = ToolBridge(client, "call_1", NullLogger())
    params = FakeParams({})
    await bridge.handler_for("x")(params)
    assert params.result == {}
