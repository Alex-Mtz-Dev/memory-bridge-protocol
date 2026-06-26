/**
 * Thermal Confidence Oracle — dynamic confidence ceilings (constraint 3).
 *
 * A node running hot has elevated probability of serving stale data:
 * CPU throttling → slower clock advancement → belief lag behind peers.
 * Its effective confidence ceiling shrinks proportionally to thermal stress.
 *
 * Model
 * ─────
 *   normalized_stress = clamp((T − T_baseline) / (T_max − T_baseline), 0, 1)
 *   thermal_penalty   = α × normalized_stress × base_ceiling
 *   effective_ceiling = max(MIN_FLOOR, base_ceiling − thermal_penalty)
 *
 * Parameters (tunable per deployment)
 * ────────────────────────────────────
 *   T_baseline = 55 °C  — idle / no throttling
 *   T_max      = 95 °C  — thermal throttle onset
 *   α          = 0.60   — max reduction: 60 % of base ceiling at T_max
 *   MIN_FLOOR  = 0.05   — liveness floor; even a scorching node gets a voice
 *
 * Example: model-class agent (base=0.40) at T=80°C
 *   normalized_stress = (80−55)/(95−55) = 0.625
 *   thermal_penalty   = 0.60 × 0.625 × 0.40 = 0.150
 *   effective_ceiling = 0.40 − 0.150 = 0.250
 */

import { createHash } from "node:crypto";
import type { TrustClass, NodeThermalState } from "./types.js";
import { BASE_CONFIDENCE_CEILING } from "./types.js";

const T_BASELINE_C = 55;
const T_MAX_C      = 95;
const ALPHA        = 0.60;
const MIN_FLOOR    = 0.05;

export class ThermalConfidenceOracle {
  /**
   * Compute effective confidence ceiling for an agent at a given temperature.
   * This is called once per epoch per agent and the result is attached to
   * every proposal that agent submits in that epoch.
   */
  compute(
    agent_id:         string,
    trust_class:      TrustClass,
    cpu_temp_celsius: number,
    sampled_at:       string = new Date().toISOString(),
  ): NodeThermalState {
    const base_ceiling      = BASE_CONFIDENCE_CEILING[trust_class];
    const normalized_stress = Math.max(0, Math.min(1,
      (cpu_temp_celsius - T_BASELINE_C) / (T_MAX_C - T_BASELINE_C),
    ));
    const thermal_penalty   = ALPHA * normalized_stress * base_ceiling;
    const effective_ceiling = Math.max(MIN_FLOOR, base_ceiling - thermal_penalty);

    return {
      agent_id,
      cpu_temp_celsius,
      base_ceiling,
      thermal_penalty:   parseFloat(thermal_penalty.toFixed(4)),
      effective_ceiling: parseFloat(effective_ceiling.toFixed(4)),
      sampled_at,
    };
  }

  /** Clamp a proposed confidence value to the agent's effective ceiling. */
  clamp(proposed: number, state: NodeThermalState): number {
    return parseFloat(Math.min(proposed, state.effective_ceiling).toFixed(4));
  }

  /**
   * Simulate temperature fluctuation for an agent across epochs.
   * Uses a deterministic hash-based noise function so the simulation is
   * reproducible without an RNG seed argument.
   */
  simulateTemp(agent_id: string, base_temp: number, epoch: number): number {
    const hash   = createHash("sha256").update(`${agent_id}:${epoch}`).digest();
    const noise  = (hash[0] / 255) * 16 - 8;   // ±8 °C oscillation
    return Math.max(40, Math.min(93, base_temp + noise));
  }
}
