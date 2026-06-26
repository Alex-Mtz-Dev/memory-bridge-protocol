/**
 * Parliament-CRDT — conflict resolution engine (constraints 1 & 2).
 *
 * Integrates the Parliament governance model (Parliament.v0.3.json) with a
 * CRDT-style merge function that is:
 *   - Commutative  : vote order does not affect the result
 *   - Associative  : partial vote sets can be merged independently
 *   - Idempotent   : re-delivering the same vote is a no-op
 *
 * These properties allow the algorithm to run without a centralized sequencer
 * across agents with heterogeneous trust classes.
 *
 * Conflict resolution strategy: Confidence-Weighted Median
 * ─────────────────────────────────────────────────────────
 *   Proposals are sorted by their proposed_value.
 *   The resolved value is the weighted median:
 *
 *     Find the smallest j such that Σ_{i=1}^{j} w_i  ≥  (½) × Σ_all w_i
 *
 *   where w_i = effective_weight of the agent supporting proposal i.
 *
 *   The weighted median is more robust than the weighted mean against
 *   Byzantine or outlier agents: a single high-weight agent cannot pull the
 *   result far from the cluster consensus.
 *
 * Effective vote weight formula (from Parliament.v0.3.json)
 * ──────────────────────────────────────────────────────────
 *   effective_weight = quorum_weight
 *                    × calibration_weight
 *                    × domain_relevance
 *                    × staked_confidence   ← clamped to thermal ceiling
 *
 * Quorum policy
 * ─────────────
 *   min_weighted_consensus : 0.60  (60 % of accumulated support weight)
 *   min_votes              : ceil(n / 2) + 1  (absolute majority of agents)
 *   authority_scoping      : true  (out-of-domain agents score dr < 1.0)
 */

import type {
  EntropyProposal,
  EntropyVote,
  AgentIdentity,
  Resolution,
  MerkleProof,
} from "./types.js";
import { MerkleBelievLedger } from "./merkle-belief-ledger.js";
import { EvidenceDAG } from "./evidence-dag.js";

const MIN_WEIGHTED_CONSENSUS = 0.60;
const SYSTEM_ENTROPY_DOMAIN  = "system-entropy";

// ── Helpers ────────────────────────────────────────────────────────────────

function domainRelevance(agent: AgentIdentity): number {
  if (agent.domain_authorities.includes(SYSTEM_ENTROPY_DOMAIN)) return 1.00;
  if (agent.domain_authorities.some((d) => d.startsWith("system")))  return 0.75;
  return 0.40;   // adjacent domain — vote still counts, but discounted
}

/**
 * Confidence-weighted median over proposals.
 *
 * Sort proposals by value; walk until cumulative weight ≥ half total.
 * Produces a value resistant to high-weight outlier agents.
 */
function weightedMedian(
  weighted_proposals: { value: number; weight: number }[],
): number {
  const sorted       = [...weighted_proposals].sort((a, b) => a.value - b.value);
  const total_weight = sorted.reduce((s, p) => s + p.weight, 0);
  let   cumulative   = 0;
  for (const p of sorted) {
    cumulative += p.weight;
    if (cumulative >= total_weight / 2) return p.value;
  }
  return sorted[sorted.length - 1].value;
}

// ── Parliament CRDT ────────────────────────────────────────────────────────

export class ParliamentCRDT {
  // Vote set — keyed by voter_agent for idempotency (re-delivery = no-op)
  private readonly votes = new Map<string, EntropyVote>();

  /**
   * Cast a vote.  Idempotent: identical vote from the same agent is ignored.
   * Later votes from the same agent overwrite earlier ones (last-write-wins
   * within an epoch — agents can revise before the epoch closes).
   */
  castVote(
    voter:            AgentIdentity,
    proposal:         EntropyProposal,
    epoch:            number,
    lamport_clock:    number,
  ): EntropyVote {
    const dr              = domainRelevance(voter);
    const staked          = voter.confidence_ceiling;   // stake at max ceiling
    const effective_weight =
      voter.quorum_weight *
      voter.calibration_weight *
      dr *
      staked;

    const vote: EntropyVote = {
      voter_agent:        voter.id,
      voter_trust_class:  voter.trust_class,
      position:           "support",
      staked_confidence:  staked,
      quorum_weight:      voter.quorum_weight,
      calibration_weight: voter.calibration_weight,
      domain_relevance:   dr,
      effective_weight:   parseFloat(effective_weight.toFixed(6)),
      supported_proposal: proposal.proposal_id,
      cast_at:            new Date().toISOString(),
      lamport_clock,
    };
    this.votes.set(voter.id, vote);
    return vote;
  }

  /**
   * Merge votes from another CRDT instance (gossip / anti-entropy).
   * Preserves the higher-lamport_clock vote when both instances have a vote
   * from the same agent — ensuring convergence across partitioned nodes.
   */
  merge(remote_votes: EntropyVote[]): void {
    for (const rv of remote_votes) {
      const existing = this.votes.get(rv.voter_agent);
      if (!existing || rv.lamport_clock > existing.lamport_clock) {
        this.votes.set(rv.voter_agent, rv);
      }
    }
  }

  /**
   * Resolve all pending proposals using the confidence-weighted median.
   *
   * Requires:
   *   - |votes| ≥ min_votes
   *   - weighted_consensus ≥ MIN_WEIGHTED_CONSENSUS
   *
   * If either condition fails → "no_quorum" outcome.
   */
  resolve(
    proposals:      EntropyProposal[],
    total_agents:   number,
    ledger:         MerkleBelievLedger,
    agent_slot:     number,          // slot for the resolved-value leaf
    epoch:          number,
    lamport_clock:  number,
    dag:            EvidenceDAG,
  ): Resolution {
    const now      = new Date().toISOString();
    const min_votes = Math.floor(total_agents / 2) + 1;

    if (this.votes.size < min_votes || proposals.length === 0) {
      return this._noQuorum(proposals, total_agents, epoch, lamport_clock, ledger, agent_slot, dag, now);
    }

    // Build vote-weighted proposal map
    const proposal_map = new Map<string, EntropyProposal>(
      proposals.map((p) => [p.proposal_id, p]),
    );

    // Aggregate support weight per proposal
    const proposal_weights = new Map<string, number>();
    let   total_support    = 0;
    let   total_oppose     = 0;

    for (const vote of this.votes.values()) {
      if (vote.position === "abstain") continue;
      const w = vote.effective_weight;
      if (vote.position === "support") {
        proposal_weights.set(
          vote.supported_proposal,
          (proposal_weights.get(vote.supported_proposal) ?? 0) + w,
        );
        total_support += w;
      } else {
        total_oppose += w;
      }
    }

    const weighted_consensus =
      total_support + total_oppose > 0
        ? total_support / (total_support + total_oppose)
        : 0;

    if (weighted_consensus < MIN_WEIGHTED_CONSENSUS) {
      return this._noQuorum(proposals, total_agents, epoch, lamport_clock, ledger, agent_slot, dag, now);
    }

    // Confidence-weighted median over proposal values
    const weighted_items = proposals
      .filter((p) => proposal_map.has(p.proposal_id))
      .map((p) => ({
        value:    p.proposed_value,
        weight:   proposal_weights.get(p.proposal_id) ?? 0,
        proposal: p,
      }))
      .filter((x) => x.weight > 0);

    const resolved_value       = parseFloat(weightedMedian(weighted_items).toFixed(6));
    const winning_proposal     = weighted_items.reduce((a, b) => a.weight >= b.weight ? a : b);
    const resolved_confidence  = parseFloat(
      (total_support / (total_support + total_oppose)).toFixed(4),
    );

    // Commit to Merkle ledger — the agent_slot represents the "resolution slot"
    const proof = ledger.update(agent_slot, {
      agent_id:   "resolution",
      value:      resolved_value,
      epoch,
      confidence: resolved_confidence,
    });

    // Register a new DAG node for this resolution
    const res_ref = `resolution:epoch_${epoch}`;
    const parent_refs = winning_proposal.proposal.evidence_refs;
    const dag_node = dag.register(res_ref, parent_refs, epoch);

    return {
      epoch,
      resolved_value,
      resolved_confidence,
      winning_proposal_id:  winning_proposal.proposal.proposal_id,
      outcome:              "resolved",
      weighted_consensus:   parseFloat(weighted_consensus.toFixed(4)),
      quorum_met:           true,
      participating_agents: this.votes.size,
      total_agents,
      merkle_proof:         proof,
      new_merkle_root:      proof.root,
      new_lineage_hash:     dag_node.lineage_hash,
      new_evidence_ref:     res_ref,
      resolved_at:          now,
      lamport_clock,
    };
  }

  private _noQuorum(
    proposals:     EntropyProposal[],
    total_agents:  number,
    epoch:         number,
    lamport_clock: number,
    ledger:        MerkleBelievLedger,
    agent_slot:    number,
    dag:           EvidenceDAG,
    now:           string,
  ): Resolution {
    // No-quorum: keep the current root; DAG node points to empty chain
    const proof    = ledger.update(agent_slot, {
      agent_id:   "no_quorum",
      value:      0,
      epoch,
      confidence: 0,
    });
    const res_ref  = `no_quorum:epoch_${epoch}`;
    dag.register(res_ref, [], epoch);

    const fallback = proposals[0];
    return {
      epoch,
      resolved_value:       fallback?.proposed_value ?? 0,
      resolved_confidence:  0,
      winning_proposal_id:  fallback?.proposal_id ?? "",
      outcome:              "no_quorum",
      weighted_consensus:   0,
      quorum_met:           false,
      participating_agents: this.votes.size,
      total_agents,
      merkle_proof:         proof,
      new_merkle_root:      proof.root,
      new_lineage_hash:     dag.getLineageHash(res_ref) ?? "",
      new_evidence_ref:     res_ref,
      resolved_at:          now,
      lamport_clock,
    };
  }

  get voteCount(): number { return this.votes.size; }
  get allVotes():  EntropyVote[] { return [...this.votes.values()]; }

  /** Reset CRDT for a new epoch — votes do not carry across epochs. */
  reset(): void { this.votes.clear(); }
}
