# Memory Bridge Protocol

**A continuity, trust, and governance layer for multi-agent systems.**

The agentic era arrived faster than the infrastructure to support it. The 2026 wave of agent hardware and runtimes — production agent CPUs, agent-targeted edge chips, fleets of coordinated workers — answered *how fast agents run* and *where they run*. None of it answered the harder question:

> When you have many agents, running across many sessions and many machines, **who do they trust, what do they remember, and how do they decide together?**

Memory Bridge Protocol is a proposal for that missing layer.

---

## The one-line positioning

**NVLink is to GPUs what Memory Bridge is to agents** — the coordination fabric that turns a collection of independent units into a single coherent system.

GPUs were already fast before NVLink. The value was in the *interconnect*: shared state, low-friction coordination, the ability to act as one. Agents are already capable. The missing piece is the interconnect for their **state, trust, and decisions**.

---

## What it actually is

Most "agent memory" tools today treat memory as a **storage problem** — embed a document, retrieve it later. Memory Bridge treats it as a **trust and coordination problem**. Four primitives:

### 1. Trust-scored beliefs
Memory is not a flat document store. Every fact, decision, open loop, and artifact is a *belief* with an epistemic status (`observed`, `inferred`, `contested`, `verified`, …), a confidence score, and a provenance trail. Beliefs decay, get superseded, and can be challenged.

### 2. Confidence ceilings by actor class
A model agent cannot assert the same authority as a human operator. Each agent carries a `trust_class` and a `confidence_ceiling`. A model writing at confidence `0.9` is **clamped** to its ceiling. This is the mechanism that prevents an agent from reading its own past output and bootstrapping false certainty — the echo-chamber failure mode of naive memory systems.

### 3. Agent identity registry
Every participating agent has an [`AgentIdentity`](schemas/AgentIdentity.v0.1.json) record: who it is, what domains it is authoritative over, how much its writes and votes weigh. Identity is the substrate everything else builds on — and today there is **no standard for it**.

### 4. Parliament governance
When agents disagree or a consequential change is proposed, it goes to a vote. Each agent's vote carries its `quorum_weight`. A proposal passes only when YES-weight meets the quorum threshold. Multi-agent decisions become **auditable**, not emergent and opaque.

---

## Why this is the gap

The current agent-memory landscape (Mem0, Zep, Letta, LangMem, Memory-OS) is strong on *recall* — vector stores, temporal graphs, stateful runtimes. The shared blind spot:

| Capability | Storage-era memory tools | Memory Bridge Protocol |
|---|---|---|
| Recall / retrieval | ✅ | ✅ |
| Temporal awareness | partial | ✅ |
| Epistemic status tracking | ❌ | ✅ |
| Confidence ceiling by actor | ❌ | ✅ |
| Agent identity standard | ❌ | ✅ |
| Multi-agent quorum governance | ❌ | ✅ |

Memory is becoming a commodity. **Trust and coordination between agents is not.** That is where this protocol lives.

---

## The AgentIdentity schema

The smallest, most portable piece of the protocol — and the right place to start. It is a single JSON object describing one agent:

```json
{
  "id": "claude",
  "name": "Claude (Anthropic)",
  "trust_class": "claude",
  "domain_authorities": ["strategy", "architecture", "writing"],
  "confidence_ceiling": 0.40,
  "quorum_weight": 0.60,
  "created_at": "2026-05-06T00:00:00.000Z",
  "registered_by": "alex"
}
```

- **Spec:** [`schemas/AgentIdentity.v0.1.json`](schemas/AgentIdentity.v0.1.json) (JSON Schema, draft 2020-12)
- **Examples:** [`schemas/examples/`](schemas/examples/)

If you build agents, you can adopt this schema today — independent of the rest of the protocol — to give your agents portable, trust-aware identities. That's the invitation.

### Validate an identity file

```bash
npx ajv-cli validate \
  -s schemas/AgentIdentity.v0.1.json \
  -d schemas/examples/claude.json \
  --spec=draft2020
```

---

## Run a bridge

A Memory Bridge instance speaks [MCP](https://modelcontextprotocol.io/) and exposes three core operations — `memory_context` (proactive recall), `memory_get` (explicit fetch), `memory_put` (persist) — plus the governance and task primitives.

### One-click deploy (Fly.io)

```bash
fly launch --copy-config --no-deploy
fly deploy
```

See [`fly.toml`](fly.toml) for the reference deployment config. A bridge instance runs comfortably on the smallest Fly machine.

---

## Status

This repository is an **early public proposal**, not a finished standard. The schema is at `v0.1`. The intent of publishing now is to test whether the trust-and-governance framing resonates with people building multi-agent systems, and to invite the schema's adoption and critique.

What you can do today:
- Adopt the `AgentIdentity` schema in your own agents
- Open an issue with how it does or doesn't fit your architecture
- Propose changes to the trust-class and governance model

What is intentionally **not** in this repo: the proprietary orchestration engine, the belief-decay services, and the hosted multi-tenant control plane. The protocol and schema are open; the operational engine is not.

---

## Roadmap

- **v0.1 (now):** AgentIdentity schema + reference bridge MCP surface + Fly.io deploy
- **v0.2:** Belief envelope schema (the structure of a `memory_put` payload) + epistemic status state machine
- **v0.3:** Parliament proposal/vote schema + quorum resolution spec
- **Later:** Framework-independent adapters (beyond MCP) and a conformance test suite

---

## License

The protocol specification and schemas in this repository are released under the [MIT License](LICENSE). See [`CONTRIBUTING.md`](CONTRIBUTING.md) to get involved.
