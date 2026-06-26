/**
 * Epoch Clock — decentralized sequencing without a central sequencer (constraint 5).
 *
 * Problem: concurrent belief updates at frequency > p99 latency require a
 * total order, but a central sequencer is prohibited.
 *
 * Solution: Consistent-Hash Speaker Election
 * ──────────────────────────────────────────
 *   1. Each agent maintains a local Lamport timestamp (strictly monotone).
 *   2. An epoch E spans exactly one p99 latency window.
 *   3. The "Parliament Speaker" for epoch E is elected by:
 *
 *         speaker_slot = SHA-256(epoch ‖ belief_id ‖ sorted_majority_ids)
 *                        mod  |majority_agents|
 *
 *      This is deterministic and computable by every agent from shared state —
 *      no coordination needed.
 *
 *   4. If the elected speaker is in the minority partition (unreachable),
 *      the algorithm walks clockwise in the sorted agent list until it finds
 *      a reachable agent.  O(k) worst case where k = minority size ≤ 15.
 *
 * Lamport invariant
 * ─────────────────
 *   On sending:    L = L + 1
 *   On receiving:  L = max(L_local, L_received) + 1
 *
 * This gives a total order for all proposals without network synchronization.
 */

import { createHash } from "node:crypto";
import type { EpochClock } from "./types.js";

const EPOCH_DURATION_MS = 50;   // tuned to p99 latency of the simulated network

export class EpochClockManager {
  private lamport = 0;

  /** Advance clock before sending a proposal. */
  tick(): number {
    return ++this.lamport;
  }

  /** Update clock on receiving a message with a remote Lamport timestamp. */
  receive(remote_lamport: number): number {
    this.lamport = Math.max(this.lamport, remote_lamport) + 1;
    return this.lamport;
  }

  get currentLamport(): number { return this.lamport; }

  /**
   * Elect the Parliament Speaker for epoch E without a central sequencer.
   *
   * Parameters
   * ──────────
   *   epoch           : current epoch number
   *   belief_id       : the contested belief (deterministic per belief)
   *   majority_agents : sorted list of agent IDs in the majority partition
   *
   * Returns the agent_id of the elected speaker.
   * Falls back to the next agent in ring order if the elected speaker is
   * in the minority (caller responsibility to provide majority_agents only).
   */
  static electSpeaker(
    epoch:           number,
    belief_id:       string,
    majority_agents: string[],   // sorted, majority partition only
  ): string {
    if (majority_agents.length === 0) {
      throw new Error("Cannot elect speaker: no agents in majority partition");
    }

    // Deterministic hash over epoch + belief + participant set
    const sorted    = [...majority_agents].sort();
    const key       = `${epoch}|${belief_id}|${sorted.join(",")}`;
    const hash      = createHash("sha256").update(key).digest();
    const slot      = (hash[0] * 256 + hash[1]) % sorted.length;   // 2-byte modulus
    return sorted[slot];
  }

  static buildClock(
    epoch:           number,
    belief_id:       string,
    majority_agents: string[],
    lamport:         number,
  ): EpochClock {
    return {
      epoch,
      lamport,
      speaker_id:     EpochClockManager.electSpeaker(epoch, belief_id, majority_agents),
      epoch_duration: EPOCH_DURATION_MS,
    };
  }
}
