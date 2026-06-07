"""
Memory Bridge Protocol — AutoGen 0.4 adapter.

Creates plain async Python functions that AutoGen's AssistantAgent accepts
directly as tools (no FunctionTool wrapper needed in AG2 0.4+).

Usage
-----
    from adapter import make_bridge_tools, inject_context

    researcher_tools = make_bridge_tools(client, actor="researcher")

    agent = AssistantAgent(
        name="Researcher",
        model_client=model_client,
        tools=researcher_tools,
        ...
    )
"""

from __future__ import annotations

from typing import Any

from client import MemoryBridgeClient


# ── Helpers ───────────────────────────────────────────────────────────────────

def _format_beliefs(beliefs: list[dict]) -> str:
    """Render beliefs as a human-readable block for agent consumption."""
    if not beliefs:
        return "(no relevant beliefs found)"
    lines = []
    for b in beliefs:
        kind   = b.get("cell_type", "?").upper()
        score  = b.get("score", 0.0)
        status = b.get("status", "?")
        text   = b.get("text", "")
        lines.append(f"[{kind} | conf:{score:.2f} | {status}] {text}")
    return "\n".join(lines)


# ── Tool factory ──────────────────────────────────────────────────────────────

def make_bridge_tools(
    client: MemoryBridgeClient,
    actor: str,
    thread_id: str = "default",
) -> list[Any]:
    """
    Return a list of async functions ready to pass to AssistantAgent(tools=[...]).

    Each tool carries the bound client/actor in its closure so agents don't
    need to supply those values at call time.

    Parameters
    ----------
    client    : MemoryBridgeClient instance (one per agent or shared)
    actor     : agent identifier written into every memory_put event
    thread_id : bridge thread to write into (namespace isolation per agent)
    """

    async def recall_beliefs(query: str, limit: int = 6) -> str:
        """
        Retrieve trust-scored beliefs from Memory Bridge Protocol.

        Returns ranked beliefs with epistemic status and confidence scores.
        Always call this before making claims that depend on shared agent knowledge.
        High-confidence beliefs (score > 0.7) from 'user' actors are authoritative.
        Model-authored beliefs (score ≤ 0.40) are inferred — treat with appropriate caution.

        Parameters
        ----------
        query : What you want to know — used to rank and filter beliefs.
        limit : Maximum number of beliefs to return (default 6, max 20).
        """
        result = await client.memory_context(task=query, limit=limit)
        beliefs = result.get("beliefs", [])
        header = f"Memory Bridge — {len(beliefs)} belief(s) for: '{query}'\n"
        return header + _format_beliefs(beliefs)

    async def persist_beliefs(
        task: str,
        summary: str,
        facts: str = "",
        decisions: str = "",
        open_loops: str = "",
        confidence: float = 0.6,
    ) -> str:
        """
        Write new beliefs into Memory Bridge Protocol.

        Use pipe ( | ) as the delimiter for multiple items in facts / decisions / open_loops.
        Confidence is automatically capped at 0.40 for model-class actors — the bridge
        enforces this server-side to prevent echo-chamber confidence inflation.
        Use fact_status 'inferred' (default) for conclusions you derived from reasoning.

        Parameters
        ----------
        task        : Brief label for what this belief relates to.
        summary     : One-sentence summary of what was learned or decided.
        facts       : Pipe-delimited list of durable facts, e.g. "X is true|Y implies Z".
        decisions   : Pipe-delimited list of decisions made.
        open_loops  : Pipe-delimited list of unresolved questions or pending tasks.
        confidence  : Your confidence 0–1 (capped at 0.40 for model-class actors).
        """
        result = await client.memory_put(
            actor=actor,
            task=task,
            summary=summary,
            facts=[f.strip() for f in facts.split("|") if f.strip()],
            decisions=[d.strip() for d in decisions.split("|") if d.strip()],
            open_loops=[o.strip() for o in open_loops.split("|") if o.strip()],
            confidence=confidence,
            thread_id=thread_id,
            fact_status="inferred",
        )
        stored  = result.get("stored", {})
        ev_count = stored.get("event_count", "?")
        return (
            f"✓ Beliefs persisted to Memory Bridge (event #{ev_count})\n"
            f"  actor={actor!r}  thread={thread_id!r}  summary={summary!r}"
        )

    return [recall_beliefs, persist_beliefs]


# ── Context injection helper ──────────────────────────────────────────────────

async def inject_context(
    client: MemoryBridgeClient,
    task: str,
    limit: int = 5,
) -> str:
    """
    Fetch live beliefs and return a formatted block for system-message injection.

    Use this before starting a conversation to prime agents with current shared state:

        ctx = await inject_context(client, task=TASK)
        agent = AssistantAgent(
            system_message=BASE_PROMPT + "\\n\\n" + ctx,
            ...
        )
    """
    result = await client.memory_context(task=task, limit=limit)
    beliefs = result.get("beliefs", [])
    if not beliefs:
        return ""
    lines = _format_beliefs(beliefs)
    return (
        "--- Memory Bridge: current shared beliefs ---\n"
        + lines
        + "\n--- end of bridge context ---"
    )
