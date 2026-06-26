/**
 * Trust-aware agentic router — TypeScript port.
 *
 * Mirrors integrations/router/trust_router.py. Decides which agent handles a
 * task and how much to trust a belief, governed by the protocol schemas:
 *
 *   schemas/AgentIdentity.v0.2.json   — who an agent is + its trust ceiling
 *   schemas/BeliefEnvelope.v0.1.json  — a single governed belief
 *
 * Two trust properties are enforced here, not assumed:
 *   1. Confidence clamping — a belief's asserted confidence is clamped to the
 *      confidence ceiling of the *registered* trust class of its source agent.
 *   2. Registry is source of truth — the trust class used for clamping comes
 *      from the registry, never from the belief's self-declared
 *      `source_trust_class`. Self-declared escalation is recorded and ignored.
 *
 * The ceiling map is imported from conflict-resolution/types.ts so there is a
 * single source of truth in TS land (kept in sync with AgentIdentity.v0.2's
 * allOf rules).
 */

// Type-only import (erased at runtime — no cross-module runtime resolution).
import type { TrustClass } from "../conflict-resolution/types.js";

export const TRUST_CLASSES: readonly TrustClass[] = ["user", "system", "claude", "model", "worker"];

// Mirror of BASE_CONFIDENCE_CEILING in conflict-resolution/types.ts and the
// allOf rules in schemas/AgentIdentity.v0.2.json — keep all three in sync.
export const CONFIDENCE_CEILING: Record<TrustClass, number> = {
  user: 1.0,
  system: 1.0,
  claude: 0.4,
  model: 0.4,
  worker: 0.3,
};
export const DEFAULT_PRECEDENCE: readonly TrustClass[] = ["user", "system", "claude", "model", "worker"];

const CELL_TYPES = ["fact", "decision", "open_loop", "artifact"] as const;
const EPISTEMIC_STATUS = ["observed", "inferred", "contested", "verified", "superseded", "quarantined"] as const;
const CONF_ROUND = 4;

// ── Schema-shaped record (the AgentIdentity.v0.2 contract) ────────────────────

export interface IdentityRecord {
  id: string;
  name: string;
  trust_class: TrustClass;
  domain_authorities: string[];
  confidence_ceiling: number;
  quorum_weight: number;
  created_at: string;
  registered_by: string;
  registered_skills?: string[];
  notes?: string;
  extensions?: Record<string, unknown>;
}

export interface BeliefEnvelope {
  belief_id: string;
  proposition: string;
  cell_type: (typeof CELL_TYPES)[number];
  source_agent: string;
  source_trust_class: TrustClass;
  confidence: number;
  epistemic_status: (typeof EPISTEMIC_STATUS)[number];
  created_at: string;
  [key: string]: unknown;
}

export interface GovernedBelief extends BeliefEnvelope {
  _governance: {
    registered_trust_class: TrustClass;
    declared_trust_class: unknown;
    trust_class_overridden: boolean;
    asserted_confidence: number;
    clamped_confidence: number;
    ceiling: number;
  };
}

export interface RoutingDecision {
  agent_id: string;
  trust_class: TrustClass;
  score: number;
  domain_match: boolean;
  reason: "authoritative" | "fallback";
}

export interface RouterPolicy {
  min_confidence: number;
  require_domain_authority: boolean;
  trust_precedence: TrustClass[];
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class TrustContractError extends Error {}
export class BeliefRejected extends Error {}
export class RoutingError extends Error {}

const REQUIRED_IDENTITY = [
  "id", "name", "trust_class", "domain_authorities",
  "confidence_ceiling", "quorum_weight", "created_at", "registered_by",
] as const;
const OPTIONAL_IDENTITY = ["registered_skills", "notes", "extensions"] as const;
const ALLOWED_IDENTITY = new Set<string>([...REQUIRED_IDENTITY, ...OPTIONAL_IDENTITY]);

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round = (n: number, dp: number): number => Number(n.toFixed(dp));

// ── AgentIdentity validation (the closed v0.2 trust contract) ─────────────────

export function validateIdentity(record: unknown): asserts record is IdentityRecord {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new TrustContractError("identity record must be an object");
  }
  const rec = record as Record<string, unknown>;

  const unknown = Object.keys(rec).filter((k) => !ALLOWED_IDENTITY.has(k));
  if (unknown.length) {
    throw new TrustContractError(
      `unknown top-level field(s) ${JSON.stringify(unknown.sort())} — authority ` +
        `fields may not be smuggled via additionalProperties; use 'extensions'`,
    );
  }
  const missing = REQUIRED_IDENTITY.filter((k) => !(k in rec));
  if (missing.length) {
    throw new TrustContractError(`missing required field(s) ${JSON.stringify(missing)}`);
  }

  const tc = rec.trust_class as TrustClass;
  if (!TRUST_CLASSES.includes(tc)) {
    throw new TrustContractError(`trust_class ${JSON.stringify(tc)} not in ${JSON.stringify(TRUST_CLASSES)}`);
  }

  const ceiling = rec.confidence_ceiling;
  if (!isNumber(ceiling)) throw new TrustContractError("confidence_ceiling must be a number");
  if (ceiling < 0) throw new TrustContractError("confidence_ceiling must be >= 0");
  if (ceiling > CONFIDENCE_CEILING[tc]) {
    throw new TrustContractError(
      `confidence_ceiling ${ceiling} exceeds the maximum ${CONFIDENCE_CEILING[tc]} for trust_class ${JSON.stringify(tc)}`,
    );
  }

  if (!isNumber(rec.quorum_weight) || (rec.quorum_weight as number) < 0) {
    throw new TrustContractError("quorum_weight must be a number >= 0");
  }
  if (!Array.isArray(rec.domain_authorities)) {
    throw new TrustContractError("domain_authorities must be an array");
  }
  if ("extensions" in rec && (typeof rec.extensions !== "object" || rec.extensions === null || Array.isArray(rec.extensions))) {
    throw new TrustContractError("extensions must be an object");
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

export class AgentRegistry {
  private agents = new Map<string, IdentityRecord>();

  register(record: unknown): IdentityRecord {
    validateIdentity(record);
    this.agents.set(record.id, record);
    return record;
  }

  get(agentId: string): IdentityRecord {
    const a = this.agents.get(agentId);
    if (!a) throw new BeliefRejected(`unknown source_agent ${JSON.stringify(agentId)} — not in registry`);
    return a;
  }

  all(): IdentityRecord[] {
    return [...this.agents.values()];
  }
}

// ── Confidence clamping ────────────────────────────────────────────────────────

/**
 * Clamp an asserted confidence to a trust class's ceiling.
 *
 * Enforces what BeliefEnvelope's `x-float-only` rule *can* be enforced at JS
 * runtime: confidence must be a finite number (not a boolean, string, NaN, or
 * Infinity) within [0, 1]. Note a platform difference from the Python port:
 * Python distinguishes `int` from `float`, so it rejects an integer-typed
 * confidence outright (the Math.round(0.40) -> 0 signature). JavaScript has a
 * single number type where 0 === 0.0, so integer-vs-float cannot be detected at
 * runtime. The float-only guarantee in TS therefore lives at the type boundary
 * (the `number` type) and should be checked against the raw JSON text upstream;
 * here we reject every other coercion signature (booleans, strings, NaN, inf).
 */
export function clampConfidence(asserted: unknown, trustClass: TrustClass): number {
  if (typeof asserted === "boolean" || !isNumber(asserted)) {
    throw new BeliefRejected(`confidence must be a finite number, got ${JSON.stringify(asserted)}`);
  }
  if (asserted < 0 || asserted > 1) {
    throw new BeliefRejected(`confidence ${asserted} out of range [0, 1]`);
  }
  return round(Math.min(asserted, CONFIDENCE_CEILING[trustClass]), CONF_ROUND);
}

// ── Belief admission ────────────────────────────────────────────────────────────

const REQUIRED_BELIEF = [
  "belief_id", "proposition", "cell_type", "source_agent",
  "source_trust_class", "confidence", "epistemic_status", "created_at",
] as const;

export function admitBelief(belief: unknown, registry: AgentRegistry): GovernedBelief {
  if (typeof belief !== "object" || belief === null || Array.isArray(belief)) {
    throw new BeliefRejected("belief must be an object");
  }
  const b = belief as Record<string, unknown>;
  const missing = REQUIRED_BELIEF.filter((k) => !(k in b));
  if (missing.length) throw new BeliefRejected(`missing required field(s) ${JSON.stringify(missing)}`);
  if (!CELL_TYPES.includes(b.cell_type as never)) throw new BeliefRejected(`invalid cell_type ${JSON.stringify(b.cell_type)}`);
  if (!EPISTEMIC_STATUS.includes(b.epistemic_status as never)) {
    throw new BeliefRejected(`invalid epistemic_status ${JSON.stringify(b.epistemic_status)}`);
  }

  // Registry is the source of truth — NOT the self-declared source_trust_class.
  const identity = registry.get(b.source_agent as string);
  const registeredClass = identity.trust_class;
  const declaredClass = b.source_trust_class;
  const spoofed = declaredClass !== registeredClass;

  const clamped = clampConfidence(b.confidence, registeredClass);

  return {
    ...(b as BeliefEnvelope),
    source_trust_class: registeredClass,
    confidence: clamped,
    _governance: {
      registered_trust_class: registeredClass,
      declared_trust_class: declaredClass,
      trust_class_overridden: spoofed,
      asserted_confidence: b.confidence as number,
      clamped_confidence: clamped,
      ceiling: CONFIDENCE_CEILING[registeredClass],
    },
  };
}

// ── Routing ─────────────────────────────────────────────────────────────────────

export const DEFAULT_POLICY: RouterPolicy = {
  min_confidence: 0,
  require_domain_authority: false,
  trust_precedence: [...DEFAULT_PRECEDENCE],
};

export class TrustRouter {
  readonly registry: AgentRegistry;
  readonly policy: RouterPolicy;
  private precedence: Map<TrustClass, number>;

  constructor(registry: AgentRegistry, policy: Partial<RouterPolicy> = {}) {
    this.registry = registry;
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.precedence = new Map(this.policy.trust_precedence.map((tc, i) => [tc, i]));
  }

  admit(belief: unknown): GovernedBelief {
    return admitBelief(belief, this.registry);
  }

  private precedenceRank(tc: TrustClass): number {
    return this.precedence.has(tc) ? (this.precedence.get(tc) as number) : this.precedence.size;
  }

  route(domain: string, candidates?: string[]): RoutingDecision[] {
    const agents = candidates ? candidates.map((c) => this.registry.get(c)) : this.registry.all();
    const decisions: RoutingDecision[] = [];
    for (const a of agents) {
      const domainMatch = a.domain_authorities.includes(domain);
      if (this.policy.require_domain_authority && !domainMatch) continue;
      const ceiling = CONFIDENCE_CEILING[a.trust_class];
      const score = round((domainMatch ? 100 : 0) + ceiling * 10 + (a.quorum_weight ?? 0), CONF_ROUND);
      decisions.push({
        agent_id: a.id,
        trust_class: a.trust_class,
        score,
        domain_match: domainMatch,
        reason: domainMatch ? "authoritative" : "fallback",
      });
    }
    if (!decisions.length) throw new RoutingError(`no eligible agent for domain ${JSON.stringify(domain)}`);
    decisions.sort((x, y) => y.score - x.score || this.precedenceRank(x.trust_class) - this.precedenceRank(y.trust_class));
    return decisions;
  }

  select(domain: string, candidates?: string[]): RoutingDecision {
    return this.route(domain, candidates)[0];
  }
}
