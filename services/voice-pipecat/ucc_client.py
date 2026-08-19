"""
Thin client for the UCC API.

Everything that decides what a caller may hear lives on the other side of this boundary.
This module fetches the tool catalogue and relays tool calls; it never interprets a result,
never caches an authorization decision, and never invents a fallback answer.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class UccClient:
    def __init__(self, base_url: str, timeout: float = 10.0) -> None:
        self._base = base_url.rstrip("/")
        self._http = httpx.AsyncClient(timeout=timeout)

    async def close(self) -> None:
        await self._http.aclose()

    async def tool_specs(self) -> list[dict[str, Any]]:
        """The one tool catalogue. Fetched rather than copied, so it cannot drift."""
        res = await self._http.get(f"{self._base}/api/ai/tools")
        res.raise_for_status()
        return res.json()["tools"]

    async def execute_tool(
        self, ucc_call_id: str, name: str, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Run one tool through the UCC gate.

        A non-2xx response is surfaced to the caller as an explicit failure rather than an
        empty result: a tool that silently returns nothing invites the model to fill the
        gap with something it made up.
        """
        res = await self._http.post(
            f"{self._base}/api/calls/{ucc_call_id}/tool",
            json={"name": name, "input": arguments},
        )
        if res.status_code >= 400:
            logger.error("UCC tool call failed: %s %s", res.status_code, res.text[:300])
            return {
                "ok": False,
                "data": {
                    "error": "TOOL_UNAVAILABLE",
                    "message": "That information is not available right now.",
                },
                "escalated": False,
            }
        return res.json()

    async def start_inbound(self, call_sid: str, from_number: str) -> dict[str, Any] | None:
        """Open the UccCall/UccTicket if the TwiML layer has not already done so."""
        res = await self._http.post(
            f"{self._base}/api/calls/inbound",
            json={
                "providerContactId": call_sid,
                "callerPhoneNumber": from_number,
                "providerEventId": f"twilio:inbound:{call_sid}",
            },
        )
        if res.status_code >= 400:
            logger.error("Could not open UCC case: %s", res.text[:300])
            return None
        return res.json()

    async def end_call(self, ucc_call_id: str, reason: str = "COMPLETED") -> None:
        await self._http.post(
            f"{self._base}/api/calls/{ucc_call_id}/end",
            json={"reason": reason, "providerEventId": f"pipecat:end:{ucc_call_id}"},
        )
