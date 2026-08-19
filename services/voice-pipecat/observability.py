"""
Structured logging and per-stage latency for the voice leg.

Mirrors the redaction contract of `packages/shared/src/logger.ts` so the two services
produce comparable, equally safe output. Redaction is applied centrally rather than trusted
to every call site, because a call site that forgets is a security incident, not a bug
(constitution Principle V, FR-037).

MEASUREMENT
-----------
Pipecat already emits TTFB and processing metrics per processor when metrics are enabled,
and ships observers for turn boundaries and user-to-bot latency. This module does not
re-time any of that; it maps what the framework reports into the UCC log shape with the
correlation id attached (FR-033, FR-034, FR-036).
"""
from __future__ import annotations

import json
import logging
import re
import sys
import time
from typing import Any, Iterable

# Values are removed entirely, at any depth. Mirrors REDACTED_KEYS on the TypeScript side.
REDACTED_KEYS = {
    "otp", "otpcode", "otphash", "code", "password", "secret", "token", "accesstoken",
    "sessiontoken", "session_token", "servicetoken", "service_token", "authorization",
    "awsaccesskeyid", "awssecretaccesskey", "awssessiontoken", "apikey", "api_key",
    "credentials", "ssn", "dateofbirth", "dob",
}

# Partially masked rather than removed, so the logs stay useful for correlation.
MASKED_KEYS = {"phone", "phonenumber", "callerid", "from", "email", "maskeddestination"}

REDACTED = "[REDACTED]"

# A standalone six-digit number anywhere in a string is scrubbed. The demo passcode can
# reach a log line through a field nobody thought of — a transcript fragment, a model
# argument, an error message — and a defensive sweep is cheaper than auditing every path.
_SIX_DIGITS = re.compile(r"(?<!\d)\d{6}(?!\d)")


def mask_value(value: str) -> str:
    """+919876543210 -> +91******3210 ; alice@x.com -> a****@x.com"""
    if "@" in value:
        local, _, domain = value.partition("@")
        head = local[:1]
        return f"{head}{'*' * max(len(local) - 1, 1)}@{domain}"
    if len(value) <= 4:
        return "*" * len(value)
    return f"{value[:3]}{'*' * max(len(value) - 7, 0)}{value[-4:]}"


def redact(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        return "[TRUNCATED]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _SIX_DIGITS.sub(REDACTED, value)
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            key = str(k).replace("_", "").replace("-", "").lower()
            if key in REDACTED_KEYS:
                out[str(k)] = REDACTED
            elif key in MASKED_KEYS and isinstance(v, str):
                out[str(k)] = mask_value(v)
            else:
                out[str(k)] = redact(v, depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        return [redact(v, depth + 1) for v in value]
    return redact(str(value), depth + 1)


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "level": record.levelname.lower(),
            "message": record.getMessage(),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "service": "ucc-voice",
        }
        extra = getattr(record, "ucc", None)
        if isinstance(extra, dict):
            payload.update(redact(extra))
        if record.exc_info:
            # The type and message only. A stack trace in a log line is fine; a stack trace
            # reaching a caller is not, and that boundary lives in bot.py.
            payload["error"] = f"{record.exc_info[0].__name__}: {record.exc_info[1]}"
        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)


class CallLogger:
    """
    A logger bound to one call.

    Every line it emits carries `uccCallId`, so a session cannot produce an untraceable
    log line by forgetting to pass it (FR-033).
    """

    def __init__(self, ucc_call_id: str, mode: str, name: str = "ucc-voice") -> None:
        self._log = logging.getLogger(name)
        self._base = {"uccCallId": ucc_call_id, "mode": mode}

    def _emit(self, level: int, message: str, **fields: Any) -> None:
        self._log.log(level, message, extra={"ucc": {**self._base, **fields}})

    def debug(self, message: str, **f: Any) -> None:
        self._emit(logging.DEBUG, message, **f)

    def info(self, message: str, **f: Any) -> None:
        self._emit(logging.INFO, message, **f)

    def warning(self, message: str, **f: Any) -> None:
        self._emit(logging.WARNING, message, **f)

    def error(self, message: str, **f: Any) -> None:
        self._emit(logging.ERROR, message, **f)

    def exception(self, message: str, **f: Any) -> None:
        self._log.exception(message, extra={"ucc": {**self._base, **f}})


class MetricsObserver:
    """
    Maps Pipecat metrics frames onto the UCC log shape.

    Kept as an observer rather than a pipeline processor because an observer sees frames
    without being inserted into the path — measurement that cannot alter what it measures.

    In `s2s` the model performs recognition, reasoning and synthesis itself, so the per-stage
    breakdown collapses into a single time-to-first-audio. That is reported as collapsed
    rather than as zeros, because zeros would read as "instantaneous" in a comparison table
    (data-model §5).
    """

    def __init__(self, logger: CallLogger, mode: str) -> None:
        self._logger = logger
        self._mode = mode

    async def on_push_frame(self, data: Any) -> None:  # pragma: no cover - needs a live pipeline
        frame = getattr(data, "frame", None)
        for metric in self._metrics_of(frame):
            name = type(metric).__name__
            if name not in ("TTFBMetricsData", "ProcessingMetricsData"):
                continue
            self._logger.info(
                "voice stage metric",
                stage=getattr(metric, "processor", "unknown"),
                metric="ttfb" if name == "TTFBMetricsData" else "processing",
                ms=round(float(getattr(metric, "value", 0.0)) * 1000, 1),
                collapsed=self._mode == "s2s",
            )

    @staticmethod
    def _metrics_of(frame: Any) -> Iterable[Any]:
        data = getattr(frame, "data", None)
        return data if isinstance(data, (list, tuple)) else ()
