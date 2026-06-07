# Memory Bridge Protocol × AutoGen

Give AutoGen 0.4 agents governed, trust-scored shared memory.

Two plain async tools — `recall_beliefs` and `persist_beliefs` — let any
`AssistantAgent` read and write to a Memory Bridge instance.
The bridge enforces epistemic rules that AutoGen doesn't have natively:
confidence ceilings by actor class, belief decay, and quorum governance.

## What this demonstrates

| Without Memory Bridge | With Memory Bridge |
|---|---|
| Agents share context only via conversation history | Agents share a persistent, cross-session belief store |
| Any agent can assert anything at any confidence | Model-class agents are capped at 0.40 confidence by the bridge |
| No provenance — who said what is lost | Every belief carries actor, timestamp, and epistemic status |
| Decisions vanish at conversation end | Decisions persist and accumulate across sessions |

## Quick start

```bash
pip install -r requirements.txt

export OPENAI_API_KEY=sk-...
export BRIDGE_URL=https://aik-memory-bridge.fly.dev/mcp
export BRIDGE_PROJECT=my-project-id

python example_research.py
```

## Use it in your own agents

```python
from autogen_agentchat.agents import AssistantAgent
from autogen_ext.models.openai import OpenAIChatCompletionClient
from client import MemoryBridgeClient
from adapter import make_bridge_tools, inject_context

bridge = MemoryBridgeClient(
    bridge_url="https://aik-memory-bridge.fly.dev/mcp",
    project_id="your-project",
)

# Optionally prime the agent with existing beliefs
ctx = await inject_context(bridge, task="your task description")

agent = AssistantAgent(
    name="Agent",
    model_client=OpenAIChatCompletionClient(model="gpt-4o-mini"),
    tools=make_bridge_tools(bridge, actor="my-agent"),
    system_message="You are a helpful agent.\n\n" + ctx,
)
```

The two tools the agent receives:

| Tool | What it does |
|---|---|
| `recall_beliefs(query, limit)` | Fetch ranked beliefs from the bridge, with confidence and epistemic status |
| `persist_beliefs(task, summary, facts, decisions, open_loops, confidence)` | Write new beliefs; bridge auto-caps model-class confidence at 0.40 |

## The confidence ceiling — why it matters

When a model-class agent writes a belief at confidence 0.9, the bridge
**clamps it to 0.40**. This prevents the echo-chamber failure mode where
an agent reads its own past output and bootstrapping false certainty.

Human operators (trust_class: `user`) write at their stated confidence.
Model agents (trust_class: `claude`, `model`, `worker`) are always capped.

The bridge enforces this server-side — your agent code doesn't need to handle it.

## Files

```
client.py            # Async MCP HTTP client — speaks JSON-RPC, no SDK dependency
adapter.py           # make_bridge_tools() + inject_context() helpers
example_research.py  # Two-agent research example (Researcher + Analyst)
requirements.txt     # Dependencies
```

## Extending this

- **More agents**: Call `make_bridge_tools(bridge, actor="name", thread_id="name")` for each.
  Different `thread_id` values namespace their writes; all agents share the same read view.
- **Custom project**: Set `project_id` on the client to isolate a team's beliefs.
- **Anthropic models**: Swap `OpenAIChatCompletionClient` for `AnthropicChatCompletionClient`
  from `autogen-ext[anthropic]`.

## Protocol reference

→ [Memory Bridge Protocol spec](https://github.com/Alex-Mtz-Dev/memory-bridge-protocol/blob/main/SPEC.md)
→ [AgentIdentity schema](https://github.com/Alex-Mtz-Dev/memory-bridge-protocol/blob/main/schemas/AgentIdentity.v0.1.json)
