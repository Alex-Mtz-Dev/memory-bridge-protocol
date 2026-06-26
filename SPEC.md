# Memory Bridge Protocol — Specification (v0.1 core, with early v0.2 deliveries)

> Status: **Draft / proposal.** This document describes the v0.1 surface. It is expected to change.

## 1. Concepts

A **Memory Bridge** is a shared, persistent store of *beliefs* about a *project*, written and read by a set of registered *agents*, with conflicts and consequential changes resolved by *governance*.

- **Project** — a namespace. All beliefs and agents belong to exactly one project.
- **Belief** — a unit of memory: a fact, decision, open loop, or artifact reference, carrying confidence and epistemic status.
- **Agent** — a participant with an [`AgentIdentity`](schemas/AgentIdentity.v0.2.json).
- **Thread** — an optional sub-namespace within a project for per-session or per-user state.

## 2. Core operations

A conformant bridge exposes three core operations (transport is MCP in the reference implementation):

### `memory_context`
Proactive recall. Given a task description and optional topic keywords, return the top-ranked active beliefs **without requiring a prior write**. This is the operation an agent calls at the start of a session to orient.

### `memory_get`
Explicit fetch. Return structured project memory — summary facts, decisions, open loops, artifacts, and relevant events — optionally scoped to a thread. Used when deeper history matters.

### `memory_put`
Persist. Write facts, decisions, open loops, and artifacts with a one-line summary. Carries `actor`, `confidence`, and `fact_status`. Confidence is **clamped to the writing agent's `confidence_ceiling`** before storage.

## 3. The trust model

The core invariant: **an agent cannot manufacture certainty it isn't entitled to.**

- Each agent has a `trust_class` and a `confidence_ceiling`.
- A `memory_put` at confidence above the ceiling is clamped, not rejected.
- Precedence on conflict: `user` > `system` > model/worker agents.
- Re-reading one's own prior beliefs must **not** increase their confidence (circular-support detection via belief provenance).

This is what separates the protocol from a vector store: the system has an opinion about *how much to believe each writer*.

## 4. Governance (preview — formalized in v0.3)

Consequential changes are submitted as **proposals**. Each registered agent may vote; votes carry the agent's `quorum_weight`. A proposal passes when the sum of YES-weights meets the configured quorum threshold. All votes and outcomes are recorded as beliefs, making the decision auditable after the fact.

## 5. Versioning

- Schemas are versioned independently (e.g. `AgentIdentity.v0.2`).
- A breaking change to any schema increments its minor version.
- This spec document tracks the protocol surface as a whole.

## 6. Early delivered v0.2 surfaces

Two v0.2 roadmap surfaces are already published:

- **Belief Envelope v0.1 schema:** [`schemas/BeliefEnvelope.v0.1.json`](schemas/BeliefEnvelope.v0.1.json)
	- Defines the governed payload for a single belief.
	- Includes portable core fields plus optional `reality_check`, `calibration`, and `consensus` modules.
- **Read-only Mem0 governance overlay:** [`integrations/mem0-overlay/`](integrations/mem0-overlay/)
	- Scores beliefs for decay, drift, contamination, and calibration.
	- Produces governance/risk assessments without mutating upstream memory stores.

## 7. What is still pending

- The formal epistemic-status transition state machine (legal transitions and guard rules) — **v0.2**

## 8. Delivered in v0.3

- Parliament proposal/vote schema: [`schemas/Parliament.v0.3.json`](schemas/Parliament.v0.3.json)
- Weighted quorum-resolution reference implementation: [`integrations/parliament/resolver.py`](integrations/parliament/resolver.py)
- Conformance suite (11 tests): [`integrations/parliament/test_resolver.py`](integrations/parliament/test_resolver.py)

Contributions toward any of these are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).
