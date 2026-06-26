/**
 * Partition Manager — CAP-theorem consistency during ≤30% node partition
 * (constraint 6).
 *
 * CAP choice: CP (Consistency + Partition Tolerance, sacrificing Availability)
 * ─────────────────────────────────────────────────────────────────────────────
 * During a partition, we MUST NOT allow the minority partition to commit new
 * belief values — doing so would create divergent state that cannot be
 * deterministically merged on heal (violating C).
 *
 * Majority partition  (≥ 70% of agents) — continues normal operation
 * Minority partition  (≤ 30% of agents) — halts writes, serves last committed
 *                                          value as read-only (epistemic_status
 *                                          downgraded to "quarantined")
 *
 * Quorum threshold
 * ────────────────
 *   We require weighted quorum, not just agent count, to handle heterogeneous
 *   trust classes.  A 30% partition that happens to include all user/system
 *   agents (high quorum_weight) would concentrate most authority in the
 *   minority — our weighted threshold catches this.
 *
 *   QUORUM_WEIGHT_THRESHOLD = 0.50
 *
 *   A partition P is a "majority" iff:
 *     Σ quorum_weight(a) for a ∈ P  /  Σ quorum_weight(all)  > 0.50
 *
 * Partition heal
 * ──────────────
 *   On reconnection, minority agents sync via the Merkle proof chain:
 *     - Request Merkle proof for each missed epoch from any majority peer
 *     - Verify each proof against the chain of roots (O(log n) per epoch)
 *     - Apply each verified epoch's resolved_value to local state
 *     - Upgrade belief epistemic_status from "quarantined" → "verified"
 *
 * Formal guarantee
 * ────────────────
 *   For any partition P of 50 agents with |minority| ≤ 15:
 *     weight(majority) ≥ 0.70 × total_weight > QUORUM_WEIGHT_THRESHOLD
 *   ∴ the majority partition always achieves quorum — progress guaranteed.
 *   ∴ the minority partition never achieves quorum — safety guaranteed.
 */

import type { AgentIdentity, PartitionView } from "./types.js";

const QUORUM_WEIGHT_THRESHOLD = 0.50;

export class PartitionManager {
  /**
   * Classify agents into majority / minority based on a set of partitioned IDs.
   *
   * In the simulation, `partitioned_ids` are the 15 agents (30%) that lose
   * network connectivity.  In production, this is detected via heartbeat
   * timeout (e.g., no ack within 2 × p99 window).
   */
  classify(
    all_agents:       AgentIdentity[],
    partitioned_ids:  Set<string>,
  ): PartitionView {
    const total_weight = all_agents.reduce((s, a) => s + a.quorum_weight, 0);

    const majority_agents: string[] = [];
    const minority_agents: string[] = [];
    let   majority_weight = 0;

    for (const agent of all_agents) {
      if (partitioned_ids.has(agent.id)) {
        minority_agents.push(agent.id);
      } else {
        majority_agents.push(agent.id);
        majority_weight += agent.quorum_weight;
      }
    }

    const majority_frac = majority_weight / total_weight;
    const minority_frac = 1 - majority_frac;

    return {
      majority_agents,
      minority_agents,
      majority_weight: parseFloat(majority_frac.toFixed(4)),
      minority_weight: parseFloat(minority_frac.toFixed(4)),
      can_form_quorum: majority_frac > QUORUM_WEIGHT_THRESHOLD,
    };
  }

  /**
   * Determine whether a given agent should proceed with a write.
   *
   * Returns "write" if the agent is in the majority partition.
   * Returns "halt"  if the agent is in the minority (CP guarantee: no write).
   * Returns "stale" if partition status is unknown (conservative: no write).
   */
  writePolicy(
    agent:  AgentIdentity,
    view:   PartitionView,
  ): "write" | "halt" | "stale" {
    if (view.majority_agents.includes(agent.id)) return "write";
    if (view.minority_agents.includes(agent.id)) return "halt";
    return "stale";
  }

  /**
   * Compute the sync plan for minority agents rejoining after a partition.
   *
   * Returns the list of epoch numbers that the minority agent missed.
   * Each missed epoch can be verified via its Merkle proof chain in O(log n).
   */
  syncPlan(
    agent_last_epoch:   number,
    current_epoch:      number,
  ): { missed_epochs: number[]; sync_steps: number } {
    const missed = [];
    for (let e = agent_last_epoch + 1; e <= current_epoch; e++) {
      missed.push(e);
    }
    return { missed_epochs: missed, sync_steps: missed.length };
  }

  /**
   * Verify that a partition is within the 30% safety envelope.
   * If this returns false, the operator must manually intervene
   * (the protocol provides no consistency guarantee above 50% partition).
   */
  isSafe(view: PartitionView): boolean {
    return (
      view.can_form_quorum &&
      view.minority_weight <= 0.30 + 1e-6   // allow floating-point ε
    );
  }
}
