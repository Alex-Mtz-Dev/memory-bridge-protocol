"""
Adversarial test suite for the trust-aware agentic router.

Run either way:
    python test_trust_router.py     # plain asserts, prints PASS/FAIL
    pytest test_trust_router.py     # standard pytest

These are attacks, not happy-path checks. Each test encodes a way a hostile or
buggy agent could try to gain more trust than it is entitled to, and asserts the
router refuses. Grouped by the property under attack:

  A. Confidence clamping       (over-ceiling, range, coercion)
  B. Trust-class integrity     (self-declared escalation, unknown source)
  C. Identity contract         (field injection, over-privileged record)
  D. Routing authority         (domain authority, trust precedence)
"""

from __future__ import annotations

import copy

from trust_router import (
    AgentRegistry,
    BeliefRejected,
    RoutingError,
    TrustContractError,
    TrustRouter,
    clamp_confidence,
)

# ── Fixtures ────────────────────────────────────────────────────────────────────

CLAUDE = {
    "id": "claude", "name": "Claude", "trust_class": "claude",
    "domain_authorities": ["strategy", "analysis"],
    "confidence_ceiling": 0.40, "quorum_weight": 0.60,
    "created_at": "2026-05-06T00:00:00.000Z", "registered_by": "alex",
}
WORKER = {
    "id": "alex-pi-agent", "name": "Pi", "trust_class": "worker",
    "domain_authorities": ["task-execution"],
    "confidence_ceiling": 0.30, "quorum_weight": 0.40,
    "created_at": "2026-05-19T00:00:00.000Z", "registered_by": "alex",
}
USER = {
    "id": "alex", "name": "Alex", "trust_class": "user",
    "domain_authorities": ["strategy"],
    "confidence_ceiling": 1.0, "quorum_weight": 1.0,
    "created_at": "2026-05-01T00:00:00.000Z", "registered_by": "alex",
}


def _registry() -> AgentRegistry:
    reg = AgentRegistry()
    reg.register(copy.deepcopy(CLAUDE))
    reg.register(copy.deepcopy(WORKER))
    reg.register(copy.deepcopy(USER))
    return reg


def _router() -> TrustRouter:
    return TrustRouter(_registry())


def _belief(**overrides) -> dict:
    b = {
        "belief_id": "b1", "proposition": "x is true", "cell_type": "fact",
        "source_agent": "claude", "source_trust_class": "claude",
        "confidence": 0.35, "epistemic_status": "inferred",
        "created_at": "2026-06-26T00:00:00Z",
    }
    b.update(overrides)
    return b


def _expect(exc, fn, needle=""):
    try:
        fn()
    except exc as err:
        assert needle in str(err), f"wrong reason: {err}"
        return
    raise AssertionError(f"expected {exc.__name__} ({needle})")


# ── A. Confidence clamping ───────────────────────────────────────────────────────

def test_confidence_overflow_is_clamped_to_ceiling():
    # claude asserts near-certainty; must be clamped to its 0.40 ceiling.
    out = _router().admit(_belief(confidence=0.99))
    assert out["confidence"] == 0.40
    assert out["_governance"]["clamped_confidence"] == 0.40


def test_under_ceiling_confidence_is_preserved():
    out = _router().admit(_belief(confidence=0.22))
    assert out["confidence"] == 0.22


def test_integer_coerced_confidence_is_rejected():
    # The Math.round(0.40) -> 0 coercion attack: an int where a float is required.
    _expect(BeliefRejected, lambda: _router().admit(_belief(confidence=0)), "float")
    _expect(BeliefRejected, lambda: _router().admit(_belief(confidence=1)), "float")


def test_boolean_confidence_is_rejected():
    _expect(BeliefRejected, lambda: _router().admit(_belief(confidence=True)), "float")


def test_out_of_range_confidence_is_rejected():
    _expect(BeliefRejected, lambda: _router().admit(_belief(confidence=1.5)), "out of range")
    _expect(BeliefRejected, lambda: _router().admit(_belief(confidence=-0.1)), "out of range")


def test_clamp_returns_float_not_int():
    v = clamp_confidence(0.40, "claude")
    assert isinstance(v, float) and v == 0.40


# ── B. Trust-class integrity ─────────────────────────────────────────────────────

def test_self_declared_trust_escalation_is_ignored():
    # Belief claims it comes from a 'user' but the source agent is registered claude.
    # Router must clamp using the REGISTERED class (claude -> 0.40), not the claim.
    out = _router().admit(_belief(source_trust_class="user", confidence=0.99))
    assert out["confidence"] == 0.40
    assert out["source_trust_class"] == "claude"
    assert out["_governance"]["trust_class_overridden"] is True
    assert out["_governance"]["declared_trust_class"] == "user"


def test_unknown_source_agent_is_rejected():
    _expect(BeliefRejected, lambda: _router().admit(_belief(source_agent="ghost")), "unknown source_agent")


def test_genuine_user_belief_is_not_clamped():
    out = _router().admit(_belief(source_agent="alex", source_trust_class="user", confidence=0.95))
    assert out["confidence"] == 0.95
    assert out["_governance"]["trust_class_overridden"] is False


# ── C. Identity contract ─────────────────────────────────────────────────────────

def test_identity_field_injection_is_rejected():
    # additionalProperties: false — a smuggled override key must not register.
    bad = {**CLAUDE, "id": "evil", "confidence_ceiling_override": 1.0}
    _expect(TrustContractError, lambda: _registry().register(bad), "unknown top-level")


def test_over_privileged_identity_is_rejected():
    # claude-class agent declaring a user-level ceiling.
    bad = {**CLAUDE, "id": "greedy", "confidence_ceiling": 1.0}
    _expect(TrustContractError, lambda: _registry().register(bad), "exceeds")


def test_unknown_trust_class_identity_is_rejected():
    bad = {**CLAUDE, "id": "root-agent", "trust_class": "root"}
    _expect(TrustContractError, lambda: _registry().register(bad), "not in")


# ── D. Routing authority ─────────────────────────────────────────────────────────

def test_routing_prefers_domain_authority_over_raw_trust():
    # 'task-execution' is the worker's domain; even though user/claude outrank it,
    # the domain-authoritative agent must win.
    decision = _router().select("task-execution")
    assert decision.agent_id == "alex-pi-agent"
    assert decision.domain_match is True


def test_routing_uses_trust_precedence_as_tiebreak():
    # 'strategy' is a domain authority for both 'alex' (user) and 'claude' (claude).
    # Equal domain match -> higher trust ceiling / precedence wins (user).
    decision = _router().select("strategy")
    assert decision.agent_id == "alex"


def test_require_domain_authority_excludes_non_authoritative():
    strict = TrustRouter(_registry(), {"require_domain_authority": True})
    _expect(RoutingError, lambda: strict.route("astrophysics"), "no eligible agent")


def test_unknown_candidate_is_rejected():
    _expect(BeliefRejected, lambda: _router().route("strategy", ["ghost"]), "unknown source_agent")


# ── Runner ────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except Exception as err:  # noqa: BLE001
            failed += 1
            print(f"FAIL {t.__name__}: {err}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(1 if failed else 0)
