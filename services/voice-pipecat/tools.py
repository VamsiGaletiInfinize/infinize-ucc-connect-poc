"""
Tool wiring for the voice pipeline.

THIS MODULE CONTAINS NO TOOL LOGIC AND NO AUTHORIZATION.

It converts the UCC catalogue into the shape the framework wants, and it hands every call
to UCC for adjudication. What a tool does, who may call it, and whether this caller is
verified are all decided on the other side of the bridge, from persisted state
(constitution Principle X, FR-024, FR-025).

The two rules that matter here:

1. `ucc_call_id` comes from the bound session, never from the model's arguments. A model
   cannot select which case it operates on.
2. A tool result is relayed verbatim — including a denial. A refusal is data the assistant
   must speak, not an error to smooth over, and an empty result invites the model to fill
   the gap with something it invented (FR-010).
"""
from __future__ import annotations

import time
from typing import Any, Awaitable, Callable

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema

from observability import CallLogger
from ucc_client import UccClient

# Bound so a stalled tool cannot hold the caller in silence indefinitely (FR-039).
TOOL_TIMEOUT_SECS = 12.0


def to_function_schema(spec: dict[str, Any]) -> FunctionSchema:
    """
    Convert one UCC tool spec into the framework's schema.

    UCC serves Bedrock Converse shapes (`inputSchema.json`), which are plain JSON Schema, so
    this is a rename rather than a translation. Doing the conversion here means the
    catalogue still has exactly one definition, on the UCC side.
    """
    json_schema = (spec.get("inputSchema") or {}).get("json") or {}
    return FunctionSchema(
        name=spec["name"],
        description=spec.get("description", ""),
        properties=json_schema.get("properties") or {},
        required=json_schema.get("required") or [],
    )


def to_tools_schema(specs: list[dict[str, Any]]) -> ToolsSchema:
    return ToolsSchema(standard_tools=[to_function_schema(s) for s in specs])


class ToolBridge:
    """
    Routes model tool calls to UCC and reports what happened.

    Holds one mutable flag — whether the call has been escalated — because the session
    lifecycle needs it to decide who ends the call. That is control flow, not policy.
    """

    def __init__(self, client: UccClient, ucc_call_id: str, logger: CallLogger) -> None:
        self._client = client
        self._ucc_call_id = ucc_call_id
        self._logger = logger
        self.escalated = False

    def handler_for(self, tool_name: str) -> Callable[[Any], Awaitable[None]]:
        async def handler(params: Any) -> None:
            args = dict(params.arguments or {})
            started = time.perf_counter()

            result = await self._client.execute_tool(self._ucc_call_id, tool_name, args)

            duration_ms = round((time.perf_counter() - started) * 1000, 1)
            if result.get("escalated"):
                self.escalated = True

            # Name, outcome and duration — never the payload. The payload is the caller's
            # protected data (FR-035, FR-037).
            self._logger.info(
                "tool invoked",
                tool=tool_name,
                ok=bool(result.get("ok")),
                control=result.get("control"),
                durationMs=duration_ms,
            )

            await params.result_callback(result.get("data", {}))

        return handler

    def register_all(self, llm: Any, specs: list[dict[str, Any]]) -> None:
        for spec in specs:
            llm.register_function(
                spec["name"],
                self.handler_for(spec["name"]),
                timeout_secs=TOOL_TIMEOUT_SECS,
            )
