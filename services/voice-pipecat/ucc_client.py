"""
Thin client for the UCC API.

Everything that decides what a caller may hear lives on the other side of this boundary.
This module fetches the tool catalogue and relays tool calls; it never interprets a result,
never caches an authorization decision, and never invents a fallback answer.

TWO CREDENTIALS, DELIBERATELY
-----------------------------
The service token proves *this process is the voice pipeline*. The session token proves
*this stream is entitled to this one case*. A shared secret alone would authenticate the
service but not the session, so any holder could read any case by guessing a call id —
which is the security property of ADR-0002 reopened one layer down (FR-027, FR-028).

See `specs/002-twilio-pipecat-voice/contracts/voice-bridge-api.md`.
"""
from __future__ import annotations

from typing import Any

import httpx

# Bounded so a hung UCC cannot hold the caller in silence. Slightly under the tool timeout
# in tools.py, so the HTTP layer gives up first and the model gets a usable failure rather
# than a cancellation (FR-039).
DEFAULT_TIMEOUT_SECS = 10.0

# What the model is told when the bridge itself fails. Never an empty object: an empty
# result invites the model to fill the gap with something plausible (FR-008, FR-010).
TOOL_UNAVAILABLE: dict[str, Any] = {
    "ok": False,
    "data": {
        "error": "TOOL_UNAVAILABLE",
        "message": "That information is not available right now.",
    },
    "escalated": False,
}


class UccAuthError(RuntimeError):
    """The voice service is not who it claims to be, or not entitled to this case."""


class UccClient:
    def __init__(
        self,
        base_url: str,
        service_token: str,
        session_token: str | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECS,
        logger: Any | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._service_token = service_token
        self._session_token = session_token
        self._logger = logger
        self._http = httpx.AsyncClient(timeout=timeout)

    async def close(self) -> None:
        await self._http.aclose()

    def bind_session(self, session_token: str) -> None:
        """Bind this client to one call. Set once, when the stream start frame arrives."""
        self._session_token = session_token

    def _headers(self, *, with_session: bool) -> dict[str, str]:
        headers = {"authorization": f"Bearer {self._service_token}"}
        if with_session:
            if not self._session_token:
                raise UccAuthError(
                    "No session token bound; refusing to call a privileged endpoint."
                )
            headers["x-ucc-session-token"] = self._session_token
        return headers

    async def verify_credentials(self) -> None:
        """
        Confirm at startup that UCC accepts our service token.

        A mismatched shared secret otherwise surfaces as a 401 on the first tool call of the
        first real caller, which is the worst possible moment to discover a typo (FR-050).
        """
        res = await self._http.get(
            f"{self._base}/api/ai/tools", headers=self._headers(with_session=False)
        )
        if res.status_code in (401, 403):
            raise UccAuthError(
                "UCC rejected the voice service credential. UCC_VOICE_SERVICE_TOKEN must "
                "match the value configured on the UCC API."
            )
        res.raise_for_status()

    async def tool_specs(self) -> list[dict[str, Any]]:
        """The one tool catalogue. Fetched rather than copied, so it cannot drift."""
        res = await self._http.get(
            f"{self._base}/api/ai/tools", headers=self._headers(with_session=False)
        )
        res.raise_for_status()
        return res.json()["tools"]

    async def execute_tool(
        self, ucc_call_id: str, name: str, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Run one tool through the UCC gate.

        Any failure is surfaced to the model as an explicit failure result rather than an
        empty one. A tool that silently returns nothing is an invitation to hallucinate.
        """
        try:
            res = await self._http.post(
                f"{self._base}/api/calls/{ucc_call_id}/tool",
                json={"name": name, "input": arguments},
                headers=self._headers(with_session=True),
            )
        except (httpx.TimeoutException, httpx.TransportError, UccAuthError) as exc:
            self._log_error("UCC tool call could not be delivered", tool=name, reason=type(exc).__name__)
            return TOOL_UNAVAILABLE

        if res.status_code >= 400:
            # Log the status, never the body: it may carry the caller's protected data, and
            # an authorization failure is exactly when that matters most.
            self._log_error("UCC tool call failed", tool=name, status=res.status_code)
            return TOOL_UNAVAILABLE

        return res.json()

    async def end_call(self, ucc_call_id: str, reason: str = "COMPLETED") -> None:
        try:
            await self._http.post(
                f"{self._base}/api/calls/{ucc_call_id}/end",
                json={"reason": reason, "providerEventId": f"pipecat:end:{ucc_call_id}"},
                headers=self._headers(with_session=True),
            )
        except (httpx.HTTPError, UccAuthError) as exc:
            # The caller has already hung up by this point; log and move on rather than
            # raising into a teardown path.
            self._log_error("Could not end UCC call", reason=type(exc).__name__)

    def _log_error(self, message: str, **fields: Any) -> None:
        if self._logger is not None:
            self._logger.error(message, **fields)
