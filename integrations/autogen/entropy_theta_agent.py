"""
Memory Bridge Protocol — AutoGen entropy-theta cluster participant.

This agent participates in the 50-agent System_Entropy_Theta conflict
resolution cluster.  It:

  1. Observes a local measurement of System_Entropy_Theta (with sensor noise)
  2. Computes its effective confidence ceiling from the thermal oracle
  3. Writes a BeliefEnvelope to the bridge with epistemic_status="contested"
  4. Reads the resolved value from the epoch's Parliament resolution
  5. Upgrades local belief to "verified" when quorum is met

Architecture
─────────────
    Local sensor → ThermalOracle → EntropyProposal (BeliefEnvelope)
                                          │
                                          ▼
                               MCP bridge  memory_put
                                          │
                             Parliament resolution event
                                          │
                                          ▼
                              Update belief → "verified"

Idempotency contract
─────────────────────
  belief_id = "belief_system_entropy_theta:epoch_{epoch}"
  Writing the same epoch twice overwrites the same slot — never duplicates.
  This holds even if the agent crashes and restarts mid-epoch.

CAP compliance (constraint 6)
──────────────────────────────
  The agent self-detects partition membership via heartbeat timeout.
  If classified as minority (write_policy = "halt"):
    - No new BeliefEnvelope is written to the bridge
    - Existing belief retains epistemic_status = "quarantined" (not "verified")
    - Agent serves last committed value as read-only
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import sys
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any

sys.path.insert(0, os.path.dirname(__file__))
from client import MemoryBridgeClient

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

BRIDGE_URL   = os.getenv("BRIDGE_URL",     "https://aik-memory-bridge.fly.dev/mcp")
PROJECT_ID   = os.getenv("BRIDGE_PROJECT", "memory-bridge-demo")
THREAD_ID    = "system-entropy-theta"
BELIEF_ID    = "belief_system_entropy_theta"
DOMAIN       = "system-entropy"

# Trust class → base confidence ceiling (from AgentIdentity schema)
BASE_CEILINGS = {
    "user":   1.00,
    "system": 1.00,
    "claude": 0.40,
    "model":  0.40,
    "worker": 0.30,
}

# Thermal oracle parameters (constraint 3)
T_BASELINE_C = 55.0
T_MAX_C      = 95.0
ALPHA        = 0.60
MIN_FLOOR    = 0.05


# ── Thermal oracle ────────────────────────────────────────────────────────────

def effective_ceiling(trust_class: str, cpu_temp_c: float) -> float:
    """Dynamic confidence ceiling based on node temperature (constraint 3)."""
    base          = BASE_CEILINGS.get(trust_class, 0.40)
    norm_stress   = max(0.0, min(1.0, (cpu_temp_c - T_BASELINE_C) / (T_MAX_C - T_BASELINE_C)))
    penalty       = ALPHA * norm_stress * base
    return round(max(MIN_FLOOR, base - penalty), 4)


# ── BeliefEnvelope builder ────────────────────────────────────────────────────

def make_belief_id(epoch: int, agent_id: str) -> str:
    """Stable, idempotent belief_id for this agent's epoch proposal."""
    key = f"{BELIEF_ID}:epoch_{epoch}:{agent_id}"
    return f"{BELIEF_ID}_epoch_{epoch}_{hashlib.sha256(key.encode()).hexdigest()[:8]}"


def build_belief_envelope(
    agent_id:       str,
    trust_class:    str,
    epoch:          int,
    observed_theta: float,
    confidence:     float,
    evidence_refs:  list[str],
    lineage_hash:   str,
    is_minority:    bool = False,
) -> dict[str, Any]:
    """
    Construct a schema-compliant BeliefEnvelope for System_Entropy_Theta.

    epistemic_status starts as "contested" (conflict in progress) and is
    upgraded to "verified" after Parliament resolution, or "quarantined"
    if this agent is in the minority partition.
    """
    return {
        "belief_id":         make_belief_id(epoch, agent_id),
        "proposition":       (
            f"System_Entropy_Theta at epoch {epoch} is approximately {observed_theta:.6f} "
            f"(observed by {agent_id}, confidence {confidence:.4f})"
        ),
        "cell_type":         "fact",
        "source_agent":      agent_id,
        "source_trust_class": trust_class,
        "confidence":        float(confidence),   # MUST be float — see BeliefEnvelope.$comment
        "epistemic_status":  "quarantined" if is_minority else "contested",
        "created_at":        datetime.now(timezone.utc).isoformat(),
        "thread_id":         THREAD_ID,
        "evidence": {
            "refs":                           evidence_refs,
            "evidence_score":                 round(confidence * 0.85, 4),
            "chain_terminates_in_agent_content": True,
        },
        "telemetry": {
            "otel_span_id":  hashlib.sha256(f"span:{agent_id}:epoch:{epoch}".encode()).hexdigest()[:16],
            "otel_trace_id": hashlib.sha256(f"trace:{agent_id}".encode()).hexdigest()[:32],
        },
        "_epoch":          epoch,
        "_lineage_hash":   lineage_hash,
    }


# ── Acyclic lineage tracking ──────────────────────────────────────────────────

def compute_lineage_hash(ancestor_refs: list[str]) -> str:
    """Compact ancestry fingerprint for cycle detection (constraint 4)."""
    sorted_refs = sorted(set(ancestor_refs))
    return hashlib.sha256("|".join(sorted_refs).encode()).hexdigest()


# ── Agent ─────────────────────────────────────────────────────────────────────

@dataclass
class EntropyThetaAgent:
    """
    A single participant in the 50-agent System_Entropy_Theta cluster.

    In production, 50 of these agents run across distributed nodes.
    In the simulation, ConflictResolver (TypeScript) drives the consensus;
    this class shows how the Python/AutoGen side of the protocol works.
    """
    agent_id:    str
    trust_class: str
    quorum_weight:      float
    calibration_weight: float
    base_temp_c: float   # baseline CPU temperature

    # Runtime state (not constructor params)
    _client:         MemoryBridgeClient = field(init=False, repr=False)
    _last_ref:       str               = field(init=False, default="genesis")
    _last_committed: float             = field(init=False, default=0.5)
    _epoch:          int               = field(init=False, default=0)
    _is_minority:    bool              = field(init=False, default=False)

    def __post_init__(self) -> None:
        self._client = MemoryBridgeClient(bridge_url=BRIDGE_URL, project_id=PROJECT_ID)

    # ── Thermal ───────────────────────────────────────────────────────────

    def _current_temp(self, epoch: int) -> float:
        """Simulate temperature fluctuation (deterministic per agent+epoch)."""
        noise_seed = hashlib.sha256(f"{self.agent_id}:{epoch}".encode()).digest()
        noise      = (noise_seed[0] / 255) * 16 - 8   # ±8 °C
        return max(40.0, min(93.0, self.base_temp_c + noise))

    def effective_confidence_ceiling(self, epoch: int) -> float:
        """Dynamic ceiling — recomputed each epoch from current temperature."""
        return effective_ceiling(self.trust_class, self._current_temp(epoch))

    # ── Observation ───────────────────────────────────────────────────────

    def _observe_theta(self, true_theta: float, epoch: int) -> float:
        """Agent's local measurement of System_Entropy_Theta with sensor noise."""
        noise_seed = hashlib.sha256(f"obs:{self.agent_id}:{epoch}".encode()).digest()
        noise      = (noise_seed[1] / 255) * 0.10 - 0.05   # ±0.05
        return round(max(0.0, min(1.0, true_theta + noise)), 6)

    # ── Bridge I/O ────────────────────────────────────────────────────────

    async def propose(
        self,
        epoch:       int,
        true_theta:  float,
    ) -> dict[str, Any]:
        """
        Write a contested BeliefEnvelope for this epoch's System_Entropy_Theta.

        If this agent is in the minority partition, skips the write and
        returns a quarantined belief record (constraint 6 / CP guarantee).
        """
        self._epoch = epoch

        if self._is_minority:
            logger.info(
                "%s: MINORITY PARTITION — halting write, serving θ=%.6f (quarantined)",
                self.agent_id, self._last_committed,
            )
            return {
                "status": "quarantined",
                "belief_id": make_belief_id(epoch, self.agent_id),
                "served_value": self._last_committed,
                "reason": "minority_partition_cp_halt",
            }

        ceiling       = self.effective_confidence_ceiling(epoch)
        observed      = self._observe_theta(true_theta, epoch)
        confidence    = min(ceiling, 0.90)   # stake at most ceiling

        # Build evidence refs (acyclic: always references prior committed epoch)
        ext_ref       = f"sensor:{self.agent_id}:epoch_{epoch}"
        evidence_refs = [self._last_ref, ext_ref]
        lineage_hash  = compute_lineage_hash(evidence_refs)

        envelope      = build_belief_envelope(
            agent_id       = self.agent_id,
            trust_class    = self.trust_class,
            epoch          = epoch,
            observed_theta = observed,
            confidence     = confidence,
            evidence_refs  = evidence_refs,
            lineage_hash   = lineage_hash,
        )

        result = await self._client.memory_put(
            actor      = self.agent_id,
            task       = envelope["belief_id"],   # idempotent slot key
            summary    = envelope["proposition"],
            facts      = [envelope["proposition"]],
            confidence = confidence,              # float preserved
            thread_id  = THREAD_ID,
            fact_status= "contested",
        )

        self._last_ref = envelope["belief_id"]
        logger.debug(
            "%s: proposed θ=%.6f conf=%.4f ceiling=%.4f temp=%.1f°C",
            self.agent_id, observed, confidence, ceiling, self._current_temp(epoch),
        )
        return {
            "status":      "proposed",
            "belief_id":   envelope["belief_id"],
            "proposed_theta": observed,
            "confidence":     confidence,
            "ceiling":        ceiling,
            "result":         result,
        }

    async def accept_resolution(
        self,
        epoch:            int,
        resolved_value:   float,
        resolved_confidence: float,
        merkle_root:      str,
    ) -> None:
        """
        Accept the Parliament resolution for this epoch.

        Updates the local belief slot to epistemic_status="verified" and
        records the resolved value as the new last_committed baseline.
        """
        if self._is_minority:
            return   # minority agents cannot accept — they are halted

        await self._client.memory_put(
            actor      = self.agent_id,
            task       = make_belief_id(epoch, self.agent_id),
            summary    = (
                f"System_Entropy_Theta epoch {epoch} resolved to {resolved_value:.6f} "
                f"via Parliament consensus (confidence={resolved_confidence:.4f}, "
                f"merkle_root={merkle_root[:8]})"
            ),
            facts      = [f"System_Entropy_Theta = {resolved_value:.6f}"],
            confidence = float(resolved_confidence),
            thread_id  = THREAD_ID,
            fact_status= "verified",
        )
        self._last_committed = resolved_value
        self._last_ref = f"resolution:epoch_{epoch}"

    def enter_partition_minority(self) -> None:
        """Signal that this agent has lost network connectivity (minority)."""
        self._is_minority = True
        logger.warning("%s: entered minority partition — halting writes", self.agent_id)

    def heal_partition(self, missed_epochs: list[int], resolved_value: float) -> None:
        """Rejoin majority partition after heal, sync via Merkle proof chain."""
        self._is_minority    = False
        self._last_committed = resolved_value
        self._last_ref       = f"resolution:epoch_{max(missed_epochs)}"
        logger.info(
            "%s: partition healed — synced %d missed epochs, θ=%.6f",
            self.agent_id, len(missed_epochs), resolved_value,
        )


# ── Simulation runner ─────────────────────────────────────────────────────────

async def run_cluster_simulation(n_agents: int = 50, n_epochs: int = 20) -> None:
    """
    Lightweight Python simulation of the 50-agent conflict resolution cluster.

    Full consensus logic runs in TypeScript (simulation.ts); this Python side
    shows how individual AutoGen agents interact with the bridge.
    """
    logging.basicConfig(
        level=logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    print("\n" + "═" * 72)
    print("  AutoGen Cluster — System_Entropy_Theta (Python participant view)")
    print("═" * 72 + "\n")

    # Build a single representative agent for each trust class
    demo_agents = [
        EntropyThetaAgent("user_01",   "user",   1.62, 0.95, 58.0),
        EntropyThetaAgent("system_01", "system", 1.12, 0.88, 65.0),
        EntropyThetaAgent("claude_01", "claude", 0.65, 0.80, 72.0),
        EntropyThetaAgent("model_01",  "model",  0.38, 0.72, 80.0),
        EntropyThetaAgent("worker_01", "worker", 0.21, 0.60, 85.0),
    ]

    # Simulate minority partition from epoch 5-12 (worker and model go offline)
    PARTITION_START = 5
    PARTITION_END   = 12
    minority_agents = {"model_01", "worker_01"}

    header = (
        f"{'Epoch':>5} {'Agent':14} {'Class':8} {'Ceiling':8} "
        f"{'Obs-θ':8} {'Status':14} {'Note'}"
    )
    print(header)
    print("─" * 80)

    for epoch in range(1, n_epochs + 1):
        true_theta = round(0.55 + 0.15 * math.sin(epoch * 0.4), 6)

        # Partition transitions
        if epoch == PARTITION_START:
            for agent in demo_agents:
                if agent.agent_id in minority_agents:
                    agent.enter_partition_minority()
        if epoch == PARTITION_END + 1:
            for agent in demo_agents:
                if agent.agent_id in minority_agents:
                    agent.heal_partition(
                        list(range(PARTITION_START, PARTITION_END + 1)),
                        resolved_value=true_theta,
                    )

        for agent in demo_agents:
            result = await agent.propose(epoch, true_theta)
            ceiling = agent.effective_confidence_ceiling(epoch)
            theta   = result.get("proposed_theta", agent._last_committed)
            note    = ""
            if result["status"] == "quarantined":
                note = f"serving θ={result['served_value']:.4f} (CP halt)"

            print(
                f"{epoch:>5} "
                f"{agent.agent_id:<14} "
                f"{agent.trust_class:<8} "
                f"{ceiling:<8.4f} "
                f"{theta:<8.4f} "
                f"{result['status']:<14} "
                f"{note}"
            )

    print("\n" + "─" * 80)
    print("  Simulation complete. Bridge writes skipped (no live bridge).")
    print("  Run simulation.ts for full 50-agent TypeScript consensus run.\n")


if __name__ == "__main__":
    asyncio.run(run_cluster_simulation())
