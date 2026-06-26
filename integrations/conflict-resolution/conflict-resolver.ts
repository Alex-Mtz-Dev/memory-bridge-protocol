/**
 * Conflict Resolver — main orchestrator for System_Entropy_Theta.
 *
 * Wires together all algorithm components into a single epoch processing loop:
 *
 *   1. ThermalConfidenceOracle  → compute dynamic ceilings for all agents
 *   2. PartitionManager         → classify majority / minority
 *   3. EpochClockManager        → elect Parliament Speaker (no central sequencer)
 *   4. EvidenceDAG              → validate + extend acyclic evidence chain
 *   5. EntropyProposal builder  → majority agents submit proposals
 *   6. ParliamentCRDT           → cast votes, merge, resolve via weighted median
 *   7. MerkleBelievLedger       → commit O(log n) proof of resolved value
 *
 * One call to processEpoch() advances the cluster by exactly one p99 window.
 * The caller (simulation.ts) drives the epoch loop.
 */

import { createHash } from "node:crypto";
import type {
  AgentIdentity,
  EntropyProposal,
  EpochResult,
  Resolution,
} from "./types.js";
import { MerkleBelievLedger }       from "./merkle-belief-ledger.js";
import { ThermalConfidenceOracle }   from "./thermal-confidence.js";
import { EvidenceDAG }               from "./evidence-dag.js";
import { EpochClockManager }         from "./epoch-clock.js";
import { ParliamentCRDT }            from "./parliament-crdt.js";
import { PartitionManager }          from "./partition-manager.js";

function sha256Short(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 8);
}

export class ConflictResolver {
  private readonly ledger:    MerkleBelievLedger;
  private readonly thermal:   ThermalConfidenceOracle;
  private readonly dag:       EvidenceDAG;
  private readonly partition: PartitionManager;
  private readonly clock:     EpochClockManager;

  private lastResolution:  Resolution | null = null;
  private lastEvidenceRef: string            = "genesis";

  constructor(private readonly agents: AgentIdentity[]) {
    this.ledger    = new MerkleBelievLedger(agents.length);
    this.thermal   = new ThermalConfidenceOracle();
    this.dag       = new EvidenceDAG();
    this.partition = new PartitionManager();
    this.clock     = new EpochClockManager();

    // Register genesis evidence node
    this.dag.register("genesis", [], 0);
  }

  /**
   * Process one epoch of the conflict-resolution protocol.
   *
   * @param epoch           monotone epoch counter
   * @param true_theta      ground-truth System_Entropy_Theta (for simulation)
   * @param partitioned_ids agents currently unreachable (empty = no partition)
   */
  processEpoch(
    epoch:           number,
    true_theta:      number,
    partitioned_ids: Set<string> = new Set(),
  ): EpochResult {
    const lamport = this.clock.tick();
    const belief_id = "belief_system_entropy_theta";

    // ── Step 1: Update thermal ceilings ───────────────────────────────────
    for (const agent of this.agents) {
      const temp     = this.thermal.simulateTemp(agent.id, agent.cpu_temp_celsius, epoch);
      const state    = this.thermal.compute(agent.id, agent.trust_class, temp);
      agent.confidence_ceiling = state.effective_ceiling;
    }

    // ── Step 2: Classify partition ────────────────────────────────────────
    const view              = this.partition.classify(this.agents, partitioned_ids);
    const partition_active  = partitioned_ids.size > 0;

    for (const agent of this.agents) {
      agent.partition = view.majority_agents.includes(agent.id)
        ? "majority"
        : view.minority_agents.includes(agent.id) ? "minority" : "unreachable";
    }

    // ── Step 3: Elect Parliament Speaker ─────────────────────────────────
    const speaker_id = EpochClockManager.electSpeaker(epoch, belief_id, view.majority_agents);

    // ── Step 4: Majority agents submit proposals ──────────────────────────
    const majority_agents  = this.agents.filter((a) => a.partition === "majority");
    const crdt             = new ParliamentCRDT();
    const proposals: EntropyProposal[] = [];

    for (const agent of majority_agents) {
      // Each agent observes true_theta + local noise (deterministic per agent+epoch)
      const noise_hash     = createHash("sha256").update(`${agent.id}:${epoch}`).digest();
      const noise          = (noise_hash[1] / 255) * 0.10 - 0.05;   // ±0.05
      const observed_theta = Math.max(0, Math.min(1, true_theta + noise));

      // Build acyclic evidence chain
      const ext_ref    = `sensor:${agent.id}:epoch_${epoch}`;
      const { refs, node } = this.dag.buildProposalRefs(
        `proposal:${agent.id}:epoch_${epoch}`,
        this.lastEvidenceRef,
        [ext_ref],
        epoch,
      );

      const proposal: EntropyProposal = {
        proposal_id:     `proposal:${agent.id}:epoch_${epoch}`,
        belief_id,
        proposing_agent: agent.id,
        proposed_value:  parseFloat(observed_theta.toFixed(6)),
        confidence:      agent.confidence_ceiling,   // float, thermally clamped
        epoch,
        lamport_clock:   lamport,
        evidence_refs:   refs,
        lineage_hash:    node.lineage_hash,
        merkle_root:     this.ledger.root,
        created_at:      new Date().toISOString(),
      };
      proposals.push(proposal);

      // Vote for own proposal
      crdt.castVote(agent, proposal, epoch, lamport);
    }

    // ── Step 5: Cross-votes — each agent also votes on neighbours' proposals
    for (const agent of majority_agents) {
      // Vote on the proposal with the highest trust-class proposer (if not own)
      const best = proposals
        .filter((p) => p.proposing_agent !== agent.id)
        .sort((a, b) => {
          const wa = this.agents.find((x) => x.id === a.proposing_agent)!;
          const wb = this.agents.find((x) => x.id === b.proposing_agent)!;
          return (wb.quorum_weight * wb.calibration_weight) -
                 (wa.quorum_weight * wa.calibration_weight);
        })[0];
      if (best) crdt.castVote(agent, best, epoch, lamport);
    }

    // ── Step 6: Resolve via weighted median ───────────────────────────────
    const speaker_slot = view.majority_agents.indexOf(speaker_id);
    const resolution   = crdt.resolve(
      proposals,
      this.agents.length,
      this.ledger,
      Math.max(0, speaker_slot),
      epoch,
      lamport,
      this.dag,
    );

    if (resolution.outcome === "resolved") {
      this.lastResolution  = resolution;
      this.lastEvidenceRef = resolution.new_evidence_ref;
    }

    // Minority agents are quarantined — they do NOT update their state
    const memory_bytes = MerkleBelievLedger.proofBytes(resolution.merkle_proof)
      + 8    // lamport
      + 32   // lineage_hash
      + 64;  // belief delta (value + confidence + epoch)

    return {
      epoch,
      resolution,
      proposals_count:  proposals.length,
      votes_count:      crdt.voteCount,
      memory_bytes,
      partition_active,
      speaker_agent:    speaker_id,
    };
  }

  /**
   * Sync a minority agent back to current state after partition heal.
   * Returns the number of epochs synced via Merkle proof chain.
   */
  syncMinorityAgent(agent: AgentIdentity, missed_epochs: number[]): number {
    if (!this.lastResolution) return 0;
    // In production: request proof for each missed epoch from any majority peer.
    // In simulation: directly apply current resolved value and upgrade status.
    agent.partition = "majority";
    return missed_epochs.length;
  }

  get currentRoot():      string            { return this.ledger.root; }
  get currentResolution(): Resolution | null { return this.lastResolution; }
  get evidenceNodeCount(): number            { return this.dag.nodeCount; }
}
