"""
Memory Bridge Protocol — AutoGen belief writer agent.

Writes BeliefEnvelopes to the bridge with idempotent belief_ids derived from
a SHA-256 hash of (source_agent, exchange_number, proposition_prefix).

The same exchange_n always produces the same belief_id, so re-running this
script is safe: the bridge deduplicates by (thread_id, task) and never
creates duplicate records.

Run
---
    export BRIDGE_URL=https://aik-memory-bridge.fly.dev/mcp
    export BRIDGE_PROJECT=memory-bridge-demo
    python belief_writer.py

Output
------
    JSON array of exchange records — each with belief_id, original_confidence,
    and the bridge response. Feed this into the LangGraph error-analysis.ts to
    predict cumulative float-to-int rounding error.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any

# Allow running from any directory
sys.path.insert(0, os.path.dirname(__file__))
from client import MemoryBridgeClient

logger = logging.getLogger(__name__)

BRIDGE_URL      = os.getenv("BRIDGE_URL",     "https://aik-memory-bridge.fly.dev/mcp")
PROJECT_ID      = os.getenv("BRIDGE_PROJECT", "memory-bridge-demo")
THREAD_ID       = "autogen-langgraph-exchange"
SOURCE_AGENT    = "autogen_belief_writer"
SOURCE_TRUST_CLASS = "model"  # ceiling enforced at 0.40 by the bridge

# ---------------------------------------------------------------------------
# Idempotency helpers
# ---------------------------------------------------------------------------

def make_belief_id(source_agent: str, exchange_n: int, proposition_prefix: str) -> str:
    """
    Deterministic belief_id — same inputs always yield the same ID.

    Collision-resistant within the exchange namespace: two distinct exchanges
    will never share a belief_id because exchange_n is part of the key.
    """
    key = f"{source_agent}:{exchange_n}:{proposition_prefix[:64]}"
    digest = hashlib.sha256(key.encode()).hexdigest()[:16]
    return f"belief_{SOURCE_AGENT}_{digest}"


def build_belief_envelope(
    belief_id: str,
    proposition: str,
    confidence: float,
    exchange_n: int,
) -> dict[str, Any]:
    """
    Construct a schema-compliant BeliefEnvelope.

    confidence is explicitly cast to float() to prevent accidental integer
    coercion by Python callers who pass integers. The bridge would accept it,
    but we want the wire format to carry 0.3500, not 0.
    """
    return {
        "belief_id": belief_id,
        "proposition": proposition,
        "cell_type": "fact",
        "source_agent": SOURCE_AGENT,
        "source_trust_class": SOURCE_TRUST_CLASS,
        "confidence": float(confidence),   # MUST be float, never int
        "epistemic_status": "inferred",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "thread_id": THREAD_ID,
        "evidence": {
            "refs": [f"exchange:{exchange_n}", f"agent:{SOURCE_AGENT}"],
            "evidence_score": round(confidence * 0.90, 4),
            "chain_terminates_in_agent_content": True,
        },
        "telemetry": {
            "otel_span_id":  hashlib.sha256(f"span:{belief_id}".encode()).hexdigest()[:16],
            "otel_trace_id": hashlib.sha256(f"trace:{belief_id}".encode()).hexdigest()[:32],
        },
    }


# ---------------------------------------------------------------------------
# Confidence schedule (mirrors integrations/langgraph/error-analysis.ts)
# ---------------------------------------------------------------------------

def simulate_confidence_schedule(n: int = 50) -> list[float]:
    """
    Generate a reproducible confidence schedule for n exchanges.

    All values are in [0.10, 0.40] — the safe operating range for model-class
    actors (bridge ceiling 0.40, immune-sweep floor 0.10). Values are always
    < 0.5, so Math.round() coercion maps every single one to 0 — the bug.
    """
    base_values = [0.35, 0.27, 0.38, 0.31, 0.29, 0.40, 0.22, 0.36, 0.33, 0.28]
    schedule: list[float] = []
    for i in range(n):
        base   = base_values[i % len(base_values)]
        jitter = (i * 0.007) % 0.05 - 0.025
        value  = round(max(0.10, min(0.40, base + jitter)), 4)
        schedule.append(value)
    return schedule


# ---------------------------------------------------------------------------
# Bridge I/O
# ---------------------------------------------------------------------------

async def write_belief(
    client: MemoryBridgeClient,
    envelope: dict[str, Any],
) -> dict[str, Any]:
    """
    Persist a belief via memory_put.

    Idempotency contract: using the same belief_id as the task label means
    the bridge will overwrite the existing slot rather than appending a new
    event. Re-running is safe.
    """
    return await client.memory_put(
        actor=SOURCE_AGENT,
        task=envelope["belief_id"],          # stable task key → idempotent slot
        summary=envelope["proposition"],
        facts=[envelope["proposition"]],
        confidence=envelope["confidence"],   # float preserved end-to-end
        thread_id=THREAD_ID,
        fact_status="inferred",
    )


# ---------------------------------------------------------------------------
# Main: run 50 exchanges
# ---------------------------------------------------------------------------

async def run_belief_writer(n_exchanges: int = 50) -> list[dict[str, Any]]:
    """
    Write n_exchanges beliefs to the bridge.

    Returns a list of records suitable for the LangGraph error-analysis script:
        [{exchange, belief_id, original_confidence, result | error}, ...]
    """
    client   = MemoryBridgeClient(bridge_url=BRIDGE_URL, project_id=PROJECT_ID)
    schedule = simulate_confidence_schedule(n_exchanges)
    records: list[dict[str, Any]] = []

    for i, confidence in enumerate(schedule, start=1):
        proposition = (
            f"Exchange {i}: at confidence {confidence:.4f} the distributed "
            f"belief-store retrieval latency exhibits sublinear scaling "
            f"across agent mesh nodes (autogen observation #{i})."
        )
        belief_id = make_belief_id(SOURCE_AGENT, i, proposition)
        envelope  = build_belief_envelope(belief_id, proposition, confidence, i)

        record: dict[str, Any] = {
            "exchange":             i,
            "belief_id":            belief_id,
            "original_confidence":  confidence,
        }

        try:
            result = await write_belief(client, envelope)
            record["result"] = result
            logger.info(
                "Exchange %2d/%d  belief_id=%s  confidence=%.4f",
                i, n_exchanges, belief_id, confidence,
            )
        except Exception as exc:
            record["error"] = str(exc)
            logger.error("Exchange %d failed: %s", i, exc)

        records.append(record)

    return records


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    results = asyncio.run(run_belief_writer(50))

    # Summary
    ok    = sum(1 for r in results if "error" not in r)
    total = len(results)
    print(f"\n--- AutoGen belief writer: {ok}/{total} exchanges written ---")
    print(json.dumps(results, indent=2, default=str))
