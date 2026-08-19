"""The client carries credentials and relays failures. It must never soften a result."""
import httpx
import pytest

from ucc_client import TOOL_UNAVAILABLE, UccAuthError, UccClient


def client(handler, session_token="sess-tok"):
    c = UccClient("http://ucc.test", "svc-tok", session_token)
    c._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return c


async def test_sends_both_credentials_on_a_tool_call():
    seen = {}

    def handler(request):
        seen.update(request.headers)
        return httpx.Response(200, json={"ok": True, "data": {}})

    await client(handler).execute_tool("call_1", "get_caller_profile", {})

    assert seen["authorization"] == "Bearer svc-tok"
    assert seen["x-ucc-session-token"] == "sess-tok"


async def test_catalogue_fetch_sends_service_credential_only():
    seen = {}

    def handler(request):
        seen.update(request.headers)
        return httpx.Response(200, json={"tools": []})

    await client(handler).tool_specs()

    assert seen["authorization"] == "Bearer svc-tok"
    assert "x-ucc-session-token" not in seen


async def test_refuses_a_privileged_call_with_no_session_token():
    """Better to fail locally than to send a request that cannot succeed."""
    c = client(lambda r: httpx.Response(200, json={}), session_token=None)
    result = await c.execute_tool("call_1", "get_caller_profile", {})
    assert result == TOOL_UNAVAILABLE


@pytest.mark.parametrize("status", [401, 403, 404, 500])
async def test_any_error_becomes_an_explicit_failure_never_an_empty_result(status):
    """An empty result invites the model to fill the gap with something it invented."""
    result = await client(lambda r: httpx.Response(status, text="nope")).execute_tool(
        "call_1", "get_application_status", {}
    )
    assert result == TOOL_UNAVAILABLE
    assert result["data"]["error"] == "TOOL_UNAVAILABLE"
    assert result["ok"] is False


async def test_timeout_becomes_an_explicit_failure():
    def handler(request):
        raise httpx.ConnectTimeout("too slow")

    assert await client(handler).execute_tool("call_1", "x", {}) == TOOL_UNAVAILABLE


async def test_successful_result_is_relayed_untouched():
    payload = {"ok": False, "data": {"error": "NOT_VERIFIED", "message": "Verify first."},
               "control": "VERIFICATION_PENDING", "escalated": False}
    result = await client(lambda r: httpx.Response(200, json=payload)).execute_tool("c", "t", {})
    assert result == payload


async def test_verify_credentials_raises_on_rejection():
    c = client(lambda r: httpx.Response(401))
    with pytest.raises(UccAuthError, match="UCC_VOICE_SERVICE_TOKEN"):
        await c.verify_credentials()


async def test_verify_credentials_passes_when_accepted():
    c = client(lambda r: httpx.Response(200, json={"tools": []}))
    await c.verify_credentials()


async def test_error_logging_never_includes_the_response_body():
    """A 403 body may carry the caller's protected data."""
    lines = []

    class Rec:
        def error(self, message, **fields):
            lines.append((message, fields))

    c = UccClient("http://ucc.test", "svc", "sess", logger=Rec())
    c._http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(403, text="SECRET-RECORD-DATA"))
    )
    await c.execute_tool("call_1", "get_application_status", {})

    assert lines, "a failure should be logged"
    assert "SECRET-RECORD-DATA" not in repr(lines)
    assert lines[0][1]["status"] == 403
