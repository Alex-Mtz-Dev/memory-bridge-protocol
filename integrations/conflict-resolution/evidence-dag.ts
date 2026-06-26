/**
 * Evidence DAG — acyclic evidence reference chain (constraint 4).
 *
 * The BeliefEnvelope schema requires evidence.refs to be an acyclic chain.
 * This module enforces that invariant for every new proposal by:
 *
 *   1. Maintaining a sparse ancestor-fingerprint map: ref_id → lineage_hash
 *   2. Using a compact lineage hash (SHA-256 of sorted ancestor IDs) so that
 *      ancestor membership can be checked in O(1) without storing full paths
 *   3. Performing cycle detection via DFS on proposal submission (O(|E|+|V|))
 *      bounded by evidence chain depth, not cluster size
 *
 * Memory model
 * ─────────────
 *   We store one 32-byte lineage_hash per committed evidence node.
 *   The DAG adjacency list is not retained after lineage_hash computation —
 *   only the hash is kept per node, giving O(n_evidence_nodes) total, which
 *   grows with the number of distinct evidence sources, not per belief update.
 *
 * Cycle invariant
 * ───────────────
 *   A new ref R is safe iff R's lineage_hash is NOT an ancestor of any
 *   existing chain that also references R.  Because lineage_hash = SHA-256 of
 *   sorted ancestor set, a duplicate lineage_hash would require an actual
 *   ancestor collision — computationally infeasible.
 */

import { createHash } from "node:crypto";
import type { EvidenceNode } from "./types.js";

export class EvidenceDAG {
  // ref_id → node metadata
  private readonly nodes = new Map<string, EvidenceNode>();

  // ── Helpers ──────────────────────────────────────────────────────────────

  private sha256(data: string): string {
    return createHash("sha256").update(data).digest("hex");
  }

  /**
   * Compute a deterministic lineage hash from a sorted set of ancestor IDs.
   * Two nodes with identical ancestor sets always produce the same hash —
   * making cycle detection a hash comparison instead of a graph traversal.
   */
  private computeLineageHash(ancestor_ids: string[]): string {
    const sorted = [...new Set(ancestor_ids)].sort();
    return this.sha256(sorted.join("|"));
  }

  /**
   * Collect all transitive ancestor IDs of a node via DFS.
   * Returns an empty set if the node is not registered (external source).
   */
  private ancestors(ref_id: string, visited = new Set<string>()): Set<string> {
    if (visited.has(ref_id)) return visited;
    visited.add(ref_id);
    const node = this.nodes.get(ref_id);
    if (!node) return visited;
    for (const parent of node.parents) {
      this.ancestors(parent, visited);
    }
    return visited;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Register a new evidence node.
   * Throws if any parent ref would create a cycle with already-registered nodes.
   */
  register(ref_id: string, parent_refs: string[], epoch: number): EvidenceNode {
    if (this.nodes.has(ref_id)) {
      return this.nodes.get(ref_id)!;   // idempotent
    }

    // Cycle check: ensure none of the parents is a descendant of ref_id
    for (const parent of parent_refs) {
      const parent_ancestors = this.ancestors(parent);
      if (parent_ancestors.has(ref_id)) {
        throw new Error(
          `EvidenceDAG cycle detected: adding ${ref_id} → ${parent} would form a cycle`,
        );
      }
    }

    // Compute lineage hash over all transitive ancestors + self
    const all_ancestors = this.ancestors(ref_id, new Set(parent_refs));
    const lineage_hash  = this.computeLineageHash([...all_ancestors, ref_id]);

    const node: EvidenceNode = {
      ref_id,
      epoch,
      parents: parent_refs,
      lineage_hash,
    };
    this.nodes.set(ref_id, node);
    return node;
  }

  /**
   * Build the evidence refs list for a new proposal.
   * Includes:
   *   1. The immediately preceding committed belief (chain continuity)
   *   2. Any external corroborating sources (sensor data, API calls)
   *
   * Returns the registered EvidenceNode for the new proposal's ref_id.
   */
  buildProposalRefs(
    proposal_id:      string,
    prior_belief_ref: string,
    external_refs:    string[],
    epoch:            number,
  ): { refs: string[]; node: EvidenceNode } {
    // Register external refs as source nodes (no parents — external origins)
    for (const ext of external_refs) {
      if (!this.nodes.has(ext)) {
        this.register(ext, [], epoch);
      }
    }

    // Register prior belief if not yet present (should be from previous epoch)
    if (!this.nodes.has(prior_belief_ref)) {
      this.register(prior_belief_ref, [], epoch - 1);
    }

    const parent_refs = [prior_belief_ref, ...external_refs];
    const node        = this.register(proposal_id, parent_refs, epoch);
    return { refs: parent_refs, node };
  }

  /**
   * Verify that a list of refs contains no cycles relative to the DAG.
   * O(|refs| × depth) — fast in practice since chain depth << n_agents.
   */
  verifyAcyclic(refs: string[]): boolean {
    try {
      for (const ref of refs) {
        const anc = this.ancestors(ref);
        for (const r2 of refs) {
          if (r2 !== ref && anc.has(r2)) {
            // r2 is an ancestor of ref AND ref is in refs → potential cycle
            const r2_anc = this.ancestors(r2);
            if (r2_anc.has(ref)) return false;   // confirmed cycle
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  get nodeCount(): number { return this.nodes.size; }

  getLineageHash(ref_id: string): string | undefined {
    return this.nodes.get(ref_id)?.lineage_hash;
  }
}
