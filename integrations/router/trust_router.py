"""
Trust-aware agentic router — Memory Bridge Protocol.

A routing core that decides *which agent* should handle a task and *how much
to trust* a belief, governed by the two protocol schemas:

  - schemas/AgentIdentity.v0.2.json   — who an agent is + its trust ceiling
  - schemas/BeliefEnvelope.v0.1.json  — a single governed belief

Two trust properties are enforced here, not assumed:

  1. CONFIDENCE CLAMPING. A belief's asserted confidence is clamped to the
     confidence ceiling of the *registered* trust class of its source agent.
     A model/claude agent can never assert above 0.40 no matter what it sends.

  2. REGISTRY IS SOURCE OF TRUTH. The trust class used for clamping comes from
     the agent registry, NOT from the belief's self-declared `source_trust_class`.
     A belief claiming `source_trust_class: "user"` from an agent registered as
     `claude` is treated as claude — self-declared escalation is ignored.

Dependency-free (stdlib only). The ceiling map MUST stay in sync with:
  - the allOf rules in schemas/AgentIdentity.v0.2.json
  - BASE_CONFIDENCE_CEILING in integrations/conflict-resolution/types.ts
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any

# ── Trust model (sync with AgentIdentity.v0.2 / types.ts) ──────────────────────

TRUST_CLASSES = ("user", "system", "claude", "model", "worker")

CONFIDENCE_CEILING: dict[str, float] = {
    "user": 1.00,
    "system": 1.00,
    "claude": 0.40,
    "model": 0.40,
    "worker": 0.30,
}

# Most-trusted first. Used as the default tie-break precedence.
DEFAULT_PRECEDENCE = ("user", "system", "claude", "model", "worker")

CELL_TYPES = ("fact", "decision", "open_loop", "artifact")
EPISTEMIC_STATUS = ("observed", "inferred", "contested", "verified", "superseded", "quarantined")

_CONF_ROUND = 4  # decimal places, mirrors thermal-confidence.ts toFixed(4)


class TrustContractError(ValueError):
    """An AgentIdentity record violates the closed trust contract."""


class BeliefRejected(ValueError):
    """A BeliefEnvelope cannot be admitted (malformed or untrusted source)."""


class RoutingError(ValueError):
    """No eligible agent could be selected for a task."""


# ── AgentIdentity validation (mirrors schemas/test_agent_identity.py) ──────────

_REQUIRED_IDENTITY = {
    "id", "name", "trust_class", "domain_authorities",
    "confidence_ceiling", "quorum_weight", "created_at", "registered_by",
}
_OPTIONAL_IDENTITY = {"registered_skills", "notes", "extensions"}
_ALLOWED_IDENTITY = _REQUIRED_IDENTITY | _OPTIONAL_IDENTITY


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def validate_identity(record: dict) -> None:
    """Enforce the closed AgentIdentity.v0.2 trust contract."""
    if not isinstance(record, dict):
        raise TrustContractError("identity record must be an object")

    unknown = set(record) - _ALLOWED_IDENTITY
    if unknown:
        raise TrustContractError(
            f"unknown top-level field(s) {sorted(unknown)} — authority fields may "
            f"not be smuggled via additionalProperties; use 'extensions'"
        )
    missing = _REQUIRED_IDENTITY - set(record)
    if missing:
        raise TrustContractError(f"missing required field(s) {sorted(missing)}")

    tc = record["trust_class"]
    if tc not in TRUST_CLASSES:
        raise TrustContractError(f"trust_class {tc!r} not in {list(TRUST_CLASSES)}")

    ceiling = record["confidence_ceiling"]
    if not _is_number(ceiling):
        raise TrustContractError("confidence_ceiling must be a number")
    if ceiling < 0:
        raise TrustContractError("confidence_ceiling must be >= 0")
    if ceiling > CONFIDENCE_CEILING[tc]:
        raise TrustContractError(
            f"confidence_ceiling {ceiling} exceeds the maximum "
            f"{CONFIDENCE_CEILING[tc]} for trust_class {tc!r}"
        )

    if not _is_number(record["quorum_weight"]) or record["quorum_weight"] < 0:
        raise TrustContractError("quorum_weight must be a number >= 0")

    if not isinstance(record["domain_authorities"], list):
        raise TrustContractError("domain_authorities must be an array")

    if "extensions" in record and not isinstance(record["extensions"], dict):
        raise TrustContractError("extensions must be an object")


# ── Registry ──────────────────────────────────────────────────────────────────

@dataclass
class AgentRegistry:
    """Holds validated AgentIdentity records, keyed by id."""

    _agents: dict[str, dict] = field(default_factory=dict)

    def register(self, record: dict) -> dict:
        validate_identity(record)
        self._agents[record["id"]] = record
        return record

    def get(self, agent_id: str) -> dict:
        if agent_id not in self._agents:
            raise BeliefRejected(f"unknown source_agent {agent_id!r} — not in registry")
        return self._agents[agent_id]

    def all(self) -> list[dict]:
        return list(self._agents.values())

    @classmethod
    def from_files(cls, *paths: str) -> "AgentRegistry":
        reg = cls()
        for p in paths:
            with open(p, encoding="utf-8") as fh:
                reg.register(json.load(fh))
        return reg


# ── Confidence clamping ────────────────────────────────────────────────────────

def clamp_confidence(asserted: Any, trust_class: str) -> float:
    """Clamp an asserted confidence to a trust class's ceiling.

    Enforces BeliefEnvelope's `x-float-only` rule: confidence MUST be an
    IEEE-754 float. Integer / boolean values are rejected because they are the
    signature of prohibited coercion (Math.round, parseInt, ~~v) that silently
    collapses sub-ceiling confidences to 0.
    """
    if isinstance(asserted, bool) or not isinstance(asserted, float):
        raise BeliefRejected(
            f"confidence must be a float, got {type(asserted).__name__} "
            f"({asserted!r}) — integer coercion is prohibited by BeliefEnvelope"
        )
    if asserted != asserted or asserted in (float("inf"), float("-inf")):  # NaN/inf
        raise BeliefRejected("confidence must be finite")
    if asserted < 0.0 or asserted > 1.0:
        raise BeliefRejected(f"confidence {asserted} out of range [0, 1]")
    ceiling = CONFIDENCE_CEILING[trust_class]
    return round(min(asserted, ceiling), _CONF_ROUND)


# ── Belief admission ────────────────────────────────────────────────────────────

_REQUIRED_BELIEF = {
    "belief_id", "proposition", "cell_type", "source_agent",
    "source_trust_class", "confidence", "epistemic_status", "created_at",
}


def admit_belief(belief: dict, registry: AgentRegistry) -> dict:
    """Validate, authenticate, and clamp a BeliefEnvelope.

    Returns a *governed* copy with `confidence` clamped to the registered
    trust class and a `_governance` block recording what the router did.
    """
    if not isinstance(belief, dict):
        raise BeliefRejected("belief must be an object")
    missing = _REQUIRED_BELIEF - set(belief)
    if missing:
        raise BeliefRejected(f"missing required field(s) {sorted(missing)}")
    if belief["cell_type"] not in CELL_TYPES:
        raise BeliefRejected(f"invalid cell_type {belief['cell_type']!r}")
    if belief["epistemic_status"] not in EPISTEMIC_STATUS:
        raise BeliefRejected(f"invalid epistemic_status {belief['epistemic_status']!r}")

    # Registry is the source of truth — NOT the self-declared source_trust_class.
    identity = registry.get(belief["source_agent"])
    registered_class = identity["trust_class"]
    declared_class = belief.get("source_trust_class")
    spoofed = declared_class != registered_class

    clamped = clamp_confidence(belief["confidence"], registered_class)

    governed = dict(belief)
    governed["source_trust_class"] = registered_class  # correct the record
    governed["confidence"] = clamped
    governed["_governance"] = {
        "registered_trust_class": registered_class,
        "declared_trust_class": declared_class,
        "trust_class_overridden": spoofed,
        "asserted_confidence": belief["confidence"],
        "clamped_confidence": clamped,
        "ceiling": CONFIDENCE_CEILING[registered_class],
    }
    return governed


# ── Routing ─────────────────────────────────────────────────────────────────────

DEFAULT_POLICY = {
    "min_confidence": 0.0,
    "require_domain_authority": False,
    "trust_precedence": list(DEFAULT_PRECEDENCE),
}


@dataclass
class RoutingDecision:
    agent_id: str
    trust_class: str
    score: float
    domain_match: bool
    reason: str


class TrustRouter:
    """Routes tasks to agents and admits beliefs, under a routing policy."""

    def __init__(self, registry: AgentRegistry, policy: dict | None = None):
        self.registry = registry
        self.policy = {**DEFAULT_POLICY, **(policy or {})}
        self._precedence = {tc: i for i, tc in enumerate(self.policy["trust_precedence"])}

    # belief side
    def admit(self, belief: dict) -> dict:
        return admit_belief(belief, self.registry)

    # routing side
    def _precedence_rank(self, trust_class: str) -> int:
        # lower rank = more trusted; unknown classes sort last
        return self._precedence.get(trust_class, len(self._precedence))

    def route(self, domain: str, candidates: list[str] | None = None) -> list[RoutingDecision]:
        """Rank eligible agents for a task in `domain`, most suitable first."""
        agents = (
            [self.registry.get(a) for a in candidates]
            if candidates is not None
            else self.registry.all()
        )
        decisions: list[RoutingDecision] = []
        for a in agents:
            domain_match = domain in a.get("domain_authorities", [])
            if self.policy["require_domain_authority"] and not domain_match:
                continue
            ceiling = CONFIDENCE_CEILING[a["trust_class"]]
            # score: domain authority dominates, then trust ceiling, then quorum weight
            score = round(
                (1.0 if domain_match else 0.0) * 100
                + ceiling * 10
                + float(a.get("quorum_weight", 0)),
                4,
            )
            decisions.append(
                RoutingDecision(
                    agent_id=a["id"],
                    trust_class=a["trust_class"],
                    score=score,
                    domain_match=domain_match,
                    reason="authoritative" if domain_match else "fallback",
                )
            )
        if not decisions:
            raise RoutingError(f"no eligible agent for domain {domain!r}")
        # sort by score desc, then trust precedence asc (tie-break)
        decisions.sort(key=lambda d: (-d.score, self._precedence_rank(d.trust_class)))
        return decisions

    def select(self, domain: str, candidates: list[str] | None = None) -> RoutingDecision:
        return self.route(domain, candidates)[0]


# ── Convenience loader ──────────────────────────────────────────────────────────

def default_registry() -> AgentRegistry:
    """Load the registry from the shipped example identities."""
    here = os.path.dirname(os.path.abspath(__file__))
    examples = os.path.join(here, "..", "..", "schemas", "examples")
    return AgentRegistry.from_files(
        os.path.join(examples, "claude.json"),
        os.path.join(examples, "worker.json"),
    )
