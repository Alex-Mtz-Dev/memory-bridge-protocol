/**
 * Core types for the Memory Bridge Protocol conflict-resolution algorithm.
 *
 * All types are compatible with:
 *   schemas/BeliefEnvelope.v0.1.json
 *   schemas/AgentIdentity.v0.1.json
 *   schemas/Parliament.v0.3.json
 */

// ── Trust model ────────────────────────────────────────────────────────────

export type TrustClass = "user" | "system" | "claude" | "model" | "worker";

/** Static ceilings from AgentIdentity schema — reduced further by thermal oracle. */
export const BASE_CONFIDENCE_CEILING: Record<TrustClass, number> = {
  user:   1.00,
  system: 1.00,
  claude: 0.40,
  model:  0.40,
  worker: 0.30,
};

// ── Agent ──────────────────────────────────────────────────────────────────

export interface AgentIdentity {
  id:                  string;
  trust_class:         TrustClass;
  quorum_weight:       number;   // structural authority
  calibration_weight:  number;   // Brier-derived, earned
  domain_authorities:  string[];
  confidence_ceiling:  number;   // effective, after thermal adjustment
  cpu_temp_celsius:    number;   // local temperature proxy for constraint 3
  partition:           "majority" | "minority" | "unreachable";
}

// ── Thermal ────────────────────────────────────────────────────────────────

export interface NodeThermalState {
  agent_id:           string;
  cpu_temp_celsius:   number;
  base_ceiling:       number;
  thermal_penalty:    number;
  effective_ceiling:  number;   // base - penalty, floored at MIN_FLOOR
  sampled_at:         string;
}

// ── Evidence DAG ──────────────────────────────────────────────────────────

export interface EvidenceNode {
  ref_id:        string;   // stable URI / belief_id
  epoch:         number;
  parents:       string[]; // direct predecessors in the DAG
  lineage_hash:  string;   // compact ancestor fingerprint (no cycles if unique)
}

// ── Epoch clock ───────────────────────────────────────────────────────────

export interface EpochClock {
  epoch:          number;   // monotone logical clock
  lamport:        number;   // Lamport timestamp for this agent
  speaker_id:     string;   // epoch Parliament Speaker (no central sequencer)
  epoch_duration: number;   // ms — tuned to p99 latency
}

// ── Entropy proposal ──────────────────────────────────────────────────────

export interface EntropyProposal {
  proposal_id:      string;
  belief_id:        "belief_system_entropy_theta";   // canonical belief
  proposing_agent:  string;
  proposed_value:   number;   // System_Entropy_Theta ∈ [0, 1]
  confidence:       number;   // float, clamped to thermal effective_ceiling
  epoch:            number;
  lamport_clock:    number;
  evidence_refs:    string[]; // acyclic chain enforced by EvidenceDAG
  lineage_hash:     string;   // ancestry fingerprint for cycle detection
  merkle_root:      string;   // current ledger root at proposal time
  created_at:       string;
}

// ── Parliament vote ───────────────────────────────────────────────────────

export interface EntropyVote {
  voter_agent:         string;
  voter_trust_class:   TrustClass;
  position:            "support" | "oppose" | "abstain";
  staked_confidence:   number;   // ≤ voter's effective_ceiling
  quorum_weight:       number;
  calibration_weight:  number;
  domain_relevance:    number;   // 1.0 = in lane; <1.0 = adjacent domain
  effective_weight:    number;   // qw × cw × dr × staked_confidence
  supported_proposal:  string;
  cast_at:             string;
  lamport_clock:       number;
}

// ── Merkle proof (O(log n) memory) ───────────────────────────────────────

export interface MerkleProof {
  leaf_index:   number;
  leaf_hash:    string;
  path:         string[];   // sibling hashes, length = ceil(log2(n))
  root:         string;
}

// ── Resolution ────────────────────────────────────────────────────────────

export type ResolutionOutcome =
  | "resolved"           // quorum met, canonical value set
  | "no_quorum"          // insufficient weighted votes
  | "partition_stalled"; // agent is in minority partition — halt writes

export interface Resolution {
  epoch:                 number;
  resolved_value:        number;   // canonical System_Entropy_Theta
  resolved_confidence:   number;   // weighted-median confidence
  winning_proposal_id:   string;
  outcome:               ResolutionOutcome;
  weighted_consensus:    number;
  quorum_met:            boolean;
  participating_agents:  number;
  total_agents:          number;
  merkle_proof:          MerkleProof;
  new_merkle_root:       string;
  new_lineage_hash:      string;
  new_evidence_ref:      string;   // ref ID to add to the next proposal's chain
  resolved_at:           string;
  lamport_clock:         number;
}

// ── Partition view ────────────────────────────────────────────────────────

export interface PartitionView {
  majority_agents:  string[];
  minority_agents:  string[];
  majority_weight:  number;   // fraction of total quorum_weight in majority
  minority_weight:  number;
  can_form_quorum:  boolean;  // majority_weight > QUORUM_THRESHOLD
}

// ── Simulation telemetry ──────────────────────────────────────────────────

export interface EpochResult {
  epoch:             number;
  resolution:        Resolution;
  proposals_count:   number;
  votes_count:       number;
  memory_bytes:      number;   // O(log n) bytes for Merkle proof + metadata
  partition_active:  boolean;
  speaker_agent:     string;
}
