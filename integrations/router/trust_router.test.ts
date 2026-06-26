/**
 * Adversarial test suite for the trust-aware agentic router (TypeScript port).
 *
 * Mirrors integrations/router/test_trust_router.py. Run with Node 22+:
 *   node --test trust_router.test.ts
 *
 * Each test encodes a way a hostile or buggy agent could try to gain more trust
 * than it is entitled to, and asserts the router refuses. Grouped by property:
 *   A. Confidence clamping   B. Trust-class integrity
 *   C. Identity contract     D. Routing authority
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  AgentRegistry,
  BeliefRejected,
  RoutingError,
  TrustContractError,
  TrustRouter,
  clampConfidence,
  type IdentityRecord,
} from "./trust_router.ts";

const CLAUDE: IdentityRecord = {
  id: "claude", name: "Claude", trust_class: "claude",
  domain_authorities: ["strategy", "analysis"],
  confidence_ceiling: 0.4, quorum_weight: 0.6,
  created_at: "2026-05-06T00:00:00.000Z", registered_by: "alex",
};
const WORKER: IdentityRecord = {
  id: "alex-pi-agent", name: "Pi", trust_class: "worker",
  domain_authorities: ["task-execution"],
  confidence_ceiling: 0.3, quorum_weight: 0.4,
  created_at: "2026-05-19T00:00:00.000Z", registered_by: "alex",
};
const USER: IdentityRecord = {
  id: "alex", name: "Alex", trust_class: "user",
  domain_authorities: ["strategy"],
  confidence_ceiling: 1.0, quorum_weight: 1.0,
  created_at: "2026-05-01T00:00:00.000Z", registered_by: "alex",
};

function registry(): AgentRegistry {
  const r = new AgentRegistry();
  r.register(structuredClone(CLAUDE));
  r.register(structuredClone(WORKER));
  r.register(structuredClone(USER));
  return r;
}
const router = () => new TrustRouter(registry());

function belief(overrides: Record<string, unknown> = {}) {
  return {
    belief_id: "b1", proposition: "x is true", cell_type: "fact",
    source_agent: "claude", source_trust_class: "claude",
    confidence: 0.35, epistemic_status: "inferred",
    created_at: "2026-06-26T00:00:00Z", ...overrides,
  };
}

// ── A. Confidence clamping ───────────────────────────────────────────────────

test("confidence overflow is clamped to ceiling", () => {
  const out = router().admit(belief({ confidence: 0.99 }));
  assert.equal(out.confidence, 0.4);
  assert.equal(out._governance.clamped_confidence, 0.4);
});

test("under-ceiling confidence is preserved", () => {
  assert.equal(router().admit(belief({ confidence: 0.22 })).confidence, 0.22);
});

test("coercion signatures (string/boolean/NaN/inf) are rejected", () => {
  // Unlike the Python port, JS cannot distinguish an int from a float at
  // runtime (0 === 0.0), so the remaining coercion signatures are these.
  assert.throws(() => router().admit(belief({ confidence: "0.4" })), BeliefRejected);
  assert.throws(() => router().admit(belief({ confidence: true })), BeliefRejected);
  assert.throws(() => router().admit(belief({ confidence: NaN })), BeliefRejected);
  assert.throws(() => router().admit(belief({ confidence: Infinity })), BeliefRejected);
});

test("out-of-range confidence is rejected", () => {
  assert.throws(() => router().admit(belief({ confidence: 1.5 })), BeliefRejected);
  assert.throws(() => router().admit(belief({ confidence: -0.1 })), BeliefRejected);
});

test("clampConfidence returns a clamped number", () => {
  assert.equal(clampConfidence(0.4, "claude"), 0.4);
  assert.equal(clampConfidence(0.99, "worker"), 0.3);
});

// ── B. Trust-class integrity ─────────────────────────────────────────────────

test("self-declared trust escalation is ignored", () => {
  const out = router().admit(belief({ source_trust_class: "user", confidence: 0.99 }));
  assert.equal(out.confidence, 0.4);
  assert.equal(out.source_trust_class, "claude");
  assert.equal(out._governance.trust_class_overridden, true);
  assert.equal(out._governance.declared_trust_class, "user");
});

test("unknown source agent is rejected", () => {
  assert.throws(() => router().admit(belief({ source_agent: "ghost" })), BeliefRejected);
});

test("genuine user belief is not clamped", () => {
  const out = router().admit(belief({ source_agent: "alex", source_trust_class: "user", confidence: 0.95 }));
  assert.equal(out.confidence, 0.95);
  assert.equal(out._governance.trust_class_overridden, false);
});

// ── C. Identity contract ─────────────────────────────────────────────────────

test("identity field injection is rejected", () => {
  const bad = { ...CLAUDE, id: "evil", confidence_ceiling_override: 1.0 };
  assert.throws(() => registry().register(bad), TrustContractError);
});

test("over-privileged identity is rejected", () => {
  const bad = { ...CLAUDE, id: "greedy", confidence_ceiling: 1.0 };
  assert.throws(() => registry().register(bad), TrustContractError);
});

test("unknown trust class identity is rejected", () => {
  const bad = { ...CLAUDE, id: "root-agent", trust_class: "root" };
  assert.throws(() => registry().register(bad), TrustContractError);
});

// ── D. Routing authority ─────────────────────────────────────────────────────

test("routing prefers domain authority over raw trust", () => {
  const d = router().select("task-execution");
  assert.equal(d.agent_id, "alex-pi-agent");
  assert.equal(d.domain_match, true);
});

test("routing uses trust precedence as tie-break", () => {
  // strategy is authoritative for both alex (user) and claude; user wins.
  assert.equal(router().select("strategy").agent_id, "alex");
});

test("require_domain_authority excludes non-authoritative", () => {
  const strict = new TrustRouter(registry(), { require_domain_authority: true });
  assert.throws(() => strict.route("astrophysics"), RoutingError);
});

test("unknown candidate is rejected", () => {
  assert.throws(() => router().route("strategy", ["ghost"]), BeliefRejected);
});
