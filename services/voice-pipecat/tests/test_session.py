"""A stream that cannot be governed must be refused, not served."""
import pytest

from bot import bind_session


def frame(**custom):
    return {"start": {"streamSid": "MZ1", "callSid": "CA1", "customParameters": custom}}


def test_binds_all_identifiers():
    stream_sid, call_sid, ucc_call_id, tenant_id, token = bind_session(
        frame(uccCallId="call_1", tenantId="infinize-university", sessionToken="tok")
    )
    assert (stream_sid, call_sid) == ("MZ1", "CA1")
    assert ucc_call_id == "call_1"
    assert tenant_id == "infinize-university"
    assert token == "tok"


def test_refuses_without_case_id():
    """No case id means the conversation cannot be traced, gated or ticketed."""
    with pytest.raises(ValueError, match="uccCallId"):
        bind_session(frame(sessionToken="tok"))


def test_refuses_without_session_token():
    """No session token means no tool can be executed; talking anyway is ungoverned."""
    with pytest.raises(ValueError, match="sessionToken"):
        bind_session(frame(uccCallId="call_1"))


def test_refuses_when_both_missing_and_names_both():
    with pytest.raises(ValueError) as exc:
        bind_session(frame())
    assert "uccCallId" in str(exc.value) and "sessionToken" in str(exc.value)


def test_whitespace_only_values_are_not_accepted():
    with pytest.raises(ValueError):
        bind_session(frame(uccCallId="   ", sessionToken="tok"))


def test_missing_custom_parameters_entirely():
    with pytest.raises(ValueError):
        bind_session({"start": {"streamSid": "MZ1", "callSid": "CA1"}})


def test_tenant_is_optional_because_it_is_not_a_security_control():
    """Tenant is carried for logging; isolation is structural in the store."""
    *_, tenant_id, _ = bind_session(frame(uccCallId="call_1", sessionToken="tok"))
    assert tenant_id == ""
