"""Redaction is central because a call site that forgets is a security incident."""
import json
import logging

from observability import CallLogger, configure_logging, mask_value, redact


def test_secret_keys_are_removed_at_any_depth():
    out = redact({"a": {"b": {"sessionToken": "abc", "authorization": "Bearer x"}}})
    assert out["a"]["b"]["sessionToken"] == "[REDACTED]"
    assert out["a"]["b"]["authorization"] == "[REDACTED]"


def test_snake_and_camel_case_keys_both_redact():
    out = redact({"session_token": "x", "sessionToken": "y", "service_token": "z"})
    assert set(out.values()) == {"[REDACTED]"}


def test_six_digit_passcode_scrubbed_from_free_text():
    """The demo passcode can arrive inside a transcript fragment, not just a field."""
    out = redact({"utterance": "my code is 123456 ok"})
    assert "123456" not in out["utterance"]


def test_longer_numbers_are_not_mangled():
    out = redact({"note": "reference 1234567890"})
    assert "1234567890" in out["note"]


def test_phone_is_masked_not_removed():
    assert mask_value("+919876543210").endswith("3210")
    assert "9876" not in mask_value("+919876543210")


def test_email_is_masked():
    assert mask_value("alice@example.com") == "a****@example.com"


def test_call_logger_always_stamps_correlation_id(capsys):
    configure_logging("INFO")
    CallLogger("call_abc123", "cascaded").info("something happened", tool="x")
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert line["uccCallId"] == "call_abc123"
    assert line["mode"] == "cascaded"
    assert line["service"] == "ucc-voice"


def test_call_logger_redacts_extra_fields(capsys):
    configure_logging("INFO")
    CallLogger("call_abc123", "s2s").info("tool invoked", sessionToken="supersecret")
    out = capsys.readouterr().out
    assert "supersecret" not in out
    logging.getLogger().handlers = []
