"""
Memory Bridge Protocol — Python MCP client.

Speaks the MCP streamable-HTTP transport (JSON-RPC over POST) directly,
so it works without tying you to a specific mcp SDK version.
Falls back gracefully when session headers are not returned.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class MemoryBridgeClient:
    """Async client for a Memory Bridge Protocol MCP server."""

    def __init__(
        self,
        bridge_url: str = "https://aik-memory-bridge.fly.dev/mcp",
        project_id: str = "alex-computer",
        timeout: float = 30.0,
    ) -> None:
        self.bridge_url = bridge_url.rstrip("/")
        self.project_id = project_id
        self.timeout = timeout
        self._session_id: str | None = None
        self._req_id = 0

    # ── Internal helpers ──────────────────────────────────────────────────

    def _next_id(self) -> int:
        self._req_id += 1
        return self._req_id

    def _headers(self) -> dict[str, str]:
        h = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self._session_id:
            h["Mcp-Session-Id"] = self._session_id
        return h

    def _parse_response(self, raw: str) -> Any:
        """Handle both plain JSON and SSE-wrapped JSON-RPC responses."""
        text = raw.strip()
        if text.startswith("data:"):
            # SSE format — concatenate data lines
            lines = [ln[5:].strip() for ln in text.splitlines() if ln.startswith("data:")]
            text = "\n".join(lines)
        rpc = json.loads(text)
        if "error" in rpc:
            raise RuntimeError(f"MCP error {rpc['error'].get('code')}: {rpc['error'].get('message')}")
        return rpc.get("result", {})

    async def _post(self, client: httpx.AsyncClient, payload: dict) -> dict | None:
        """POST a JSON-RPC payload and return the parsed result (or None for notifications)."""
        is_notification = "id" not in payload
        r = await client.post(
            self.bridge_url,
            json=payload,
            headers=self._headers(),
            timeout=self.timeout,
        )
        r.raise_for_status()

        # Capture session ID when the server issues one
        if sid := r.headers.get("Mcp-Session-Id"):
            self._session_id = sid
            logger.debug("MCP session established: %s", sid)

        if is_notification or not r.text.strip():
            return None

        return self._parse_response(r.text)

    # ── MCP protocol handshake ────────────────────────────────────────────

    async def _ensure_session(self, client: httpx.AsyncClient) -> None:
        """Run the MCP initialize / initialized handshake once per client."""
        if self._session_id:
            return
        await self._post(client, {
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "memory-bridge-autogen", "version": "0.1.0"},
            },
            "id": self._next_id(),
        })
        # Notification — no id field
        await self._post(client, {
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {},
        })

    async def _call_tool(self, tool: str, arguments: dict) -> Any:
        """Execute a single MCP tool call."""
        async with httpx.AsyncClient() as client:
            await self._ensure_session(client)
            result = await self._post(client, {
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {"name": tool, "arguments": arguments},
                "id": self._next_id(),
            })
        # MCP wraps tool output in result.content[0].text
        if isinstance(result, dict) and "content" in result:
            for block in result["content"]:
                if block.get("type") == "text":
                    try:
                        return json.loads(block["text"])
                    except json.JSONDecodeError:
                        return block["text"]
        return result

    # ── Public API — mirrors the bridge's three core operations ──────────

    async def memory_context(
        self,
        task: str,
        topics: list[str] | None = None,
        limit: int = 8,
        min_score: float = 0.0,
    ) -> dict:
        """
        Proactively surface ranked active beliefs for a task.
        Returns: { beliefs: [{belief_id, cell_type, text, status, score}], summary: {...} }
        """
        return await self._call_tool("memory_context", {
            "project_id": self.project_id,
            "task": task,
            "topics": topics or [],
            "limit": limit,
            "min_score": min_score,
        })

    async def memory_get(
        self,
        task: str,
        thread_id: str = "default",
        topics: list[str] | None = None,
        limit: int = 8,
    ) -> dict:
        """Retrieve event history for a specific thread."""
        return await self._call_tool("memory_get", {
            "project_id": self.project_id,
            "task": task,
            "thread_id": thread_id,
            "topics": topics or [],
            "limit": limit,
        })

    async def memory_put(
        self,
        actor: str,
        task: str,
        summary: str = "",
        facts: list[str] | None = None,
        decisions: list[str] | None = None,
        open_loops: list[str] | None = None,
        artifacts: list[str] | None = None,
        confidence: float = 0.6,
        thread_id: str = "default",
        fact_status: str = "inferred",
        ttl_days: int | None = None,
    ) -> dict:
        """
        Persist beliefs to the bridge.
        Note: confidence is automatically capped by actor trust class on the server
        (model-class actors cap at 0.40; user-class actors are uncapped).
        """
        args: dict[str, Any] = {
            "project_id": self.project_id,
            "actor": actor,
            "task": task,
            "summary": summary,
            "facts": facts or [],
            "decisions": decisions or [],
            "open_loops": open_loops or [],
            "artifacts": artifacts or [],
            "confidence": confidence,
            "thread_id": thread_id,
            "fact_status": fact_status,
        }
        if ttl_days is not None:
            args["ttl_days"] = ttl_days
        return await self._call_tool("memory_put", args)
