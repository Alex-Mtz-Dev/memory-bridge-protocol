"""
Memory Bridge Protocol × AutoGen 0.4 — Research team example.

Two agents (Researcher and Analyst) collaborate on a topic.
They share governed, trust-scored beliefs via Memory Bridge Protocol:
  - Researcher discovers facts → persists them as 'inferred' beliefs
  - Analyst reads the trust-scored beliefs, builds on them, persists analysis
  - Both agents see confidence ceilings enforced by the bridge (model-class cap: 0.40)
  - At the end: dump the raw beliefs to show what Memory Bridge actually stored

Setup
-----
    pip install -r requirements.txt
    export OPENAI_API_KEY=sk-...
    export BRIDGE_URL=https://aik-memory-bridge.fly.dev/mcp   # or your own instance
    export BRIDGE_PROJECT=memory-bridge-demo

Run
---
    python example_research.py
"""

from __future__ import annotations

import asyncio
import os

from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.conditions import MaxMessageTermination, TextMentionTermination
from autogen_agentchat.teams import RoundRobinGroupChat
from autogen_agentchat.ui import Console
from autogen_ext.models.openai import OpenAIChatCompletionClient

from adapter import inject_context, make_bridge_tools
from client import MemoryBridgeClient

# ── Config ────────────────────────────────────────────────────────────────────

BRIDGE_URL  = os.getenv("BRIDGE_URL",     "https://aik-memory-bridge.fly.dev/mcp")
PROJECT_ID  = os.getenv("BRIDGE_PROJECT", "memory-bridge-demo")
OPENAI_KEY  = os.getenv("OPENAI_API_KEY", "")
MODEL       = os.getenv("OPENAI_MODEL",   "gpt-4o-mini")

RESEARCH_TASK = (
    "What are the architectural gaps in current agent memory frameworks "
    "(Mem0, Zep, Letta, LangMem) and what primitives would fill them?"
)

# ── System prompts ────────────────────────────────────────────────────────────

RESEARCHER_PROMPT = """\
You are a technical Researcher specialising in AI agent infrastructure.

Your job:
1. Use `recall_beliefs` to check what's already known before researching.
2. Investigate the assigned topic rigorously.
3. Use `persist_beliefs` to record each significant finding:
   - Set facts to pipe-delimited key facts (e.g. "Mem0 lacks governance|Zep has temporal graph").
   - Set open_loops for anything you couldn't confirm.
   - Use confidence ≤ 0.8 (bridge will cap at 0.40 for your actor class — that's expected).
4. End your final message with the word HANDOFF so the Analyst can proceed.

Be specific. Vague generalities aren't worth persisting.
"""

ANALYST_PROMPT = """\
You are a technical Analyst who synthesises researcher findings into strategic conclusions.

Your job:
1. Use `recall_beliefs` to load everything the Researcher stored.
2. Examine the epistemic status and confidence of each belief carefully —
   beliefs with conf < 0.4 are model-inferred and should be treated as hypotheses.
3. Build on well-supported beliefs to derive strategic conclusions.
4. Use `persist_beliefs` to record your analysis:
   - Set decisions for concrete conclusions.
   - Flag contested or low-confidence beliefs in open_loops.
5. End your final message with ANALYSIS_COMPLETE.

Be direct. If a researcher belief has low confidence, say so rather than presenting it as fact.
"""

# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    if not OPENAI_KEY:
        raise ValueError("Set OPENAI_API_KEY environment variable.")

    # Shared bridge client (both agents read from same project)
    bridge = MemoryBridgeClient(bridge_url=BRIDGE_URL, project_id=PROJECT_ID)

    # Pre-load any existing beliefs as context
    print("\n⟳ Fetching existing bridge context...\n")
    ctx = await inject_context(bridge, task=RESEARCH_TASK, limit=4)
    if ctx:
        print(ctx, "\n")
    else:
        print("(no prior beliefs in this project)\n")

    # Model client — shared, cost-efficient model for this demo
    model_client = OpenAIChatCompletionClient(
        model=MODEL,
        api_key=OPENAI_KEY,
        max_tokens=1024,
    )

    # Researcher — uses its own thread so writes are namespaced
    researcher_tools = make_bridge_tools(bridge, actor="researcher", thread_id="research")
    researcher = AssistantAgent(
        name="Researcher",
        model_client=model_client,
        tools=researcher_tools,
        system_message=RESEARCHER_PROMPT + ("\n\n" + ctx if ctx else ""),
        max_tool_iterations=6,
        reflect_on_tool_use=False,
    )

    # Analyst — reads from shared context, writes to analysis thread
    analyst_tools = make_bridge_tools(bridge, actor="analyst", thread_id="analysis")
    analyst = AssistantAgent(
        name="Analyst",
        model_client=model_client,
        tools=analyst_tools,
        system_message=ANALYST_PROMPT,
        max_tool_iterations=6,
        reflect_on_tool_use=False,
    )

    # Team: round-robin, stop when analyst signals completion or message limit hit
    termination = (
        TextMentionTermination("ANALYSIS_COMPLETE")
        | MaxMessageTermination(max_messages=10)
    )
    team = RoundRobinGroupChat(
        [researcher, analyst],
        termination_condition=termination,
    )

    print(f"━━━ Research task ━━━\n{RESEARCH_TASK}\n")
    print("━━━ Running team (bridge at:", BRIDGE_URL, ") ━━━\n")

    await Console(team.run_stream(task=RESEARCH_TASK))

    # ── Post-run: show what the bridge actually stored ────────────────────
    print("\n\n━━━ Memory Bridge: final belief state ━━━")
    result = await bridge.memory_context(task=RESEARCH_TASK, limit=12)
    beliefs = result.get("beliefs", [])
    print(f"Total active beliefs: {len(beliefs)}\n")
    for b in beliefs:
        actor_tag = ""
        if b.get("belief_id", "").startswith("fact:"):
            actor_tag = "[fact]"
        elif b.get("belief_id", "").startswith("decision:"):
            actor_tag = "[decision]"
        print(
            f"  {b.get('cell_type','?'):10s} | "
            f"score:{b.get('score',0):.2f} | "
            f"{b.get('status','?'):12s} | "
            f"{b.get('text','')[:80]}"
        )

    print("\n━━━ Key: conf ≤ 0.40 = model-inferred (bridge-enforced ceiling) ━━━")


if __name__ == "__main__":
    asyncio.run(main())
