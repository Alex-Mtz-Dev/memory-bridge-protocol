"""
Memory Bridge Protocol — AgentIdentity trust-contract conformance tests.

Run either way:
    python test_agent_identity.py     # plain asserts, prints PASS/FAIL
    pytest test_agent_identity.py     # standard pytest

These pin the *security* invariants of AgentIdentity.v0.2.json so that
"schema-valid" continues to imply "trust-contract intact":

  1. The top-level contract is closed — unknown top-level keys are rejected
     (no additionalProperties smuggling of authority fields).
  2. trust_class is constrained to the known tier enum.
  3. confidence_ceiling can never exceed the per-class maximum, so a record
     cannot self-declare more confidence headroom than the runtime grants.
  4. Forward-compat metadata is only accepted inside `extensions`.

This is a dependency-free checker (no `jsonschema` needed). The per-class
ceiling map MUST stay in sync with:
  - the allOf rules in schemas/AgentIdentity.v0.2.json
  - BASE_CONFIDENCE_CEILING in integrations/conflict-resolution/types.ts
"""

from __future__ import annotations

import json
import os

SCHEMA_DIR = os.path.dirname(os.path.abspath(__file__))

REQUIRED = {
    "id", "name", "trust_class", "domain_authorities",
    "confidence_ceiling", "quorum_weight", "created_at", "registered_by",
}
OPTIONAL = {"registered_skills", "notes", "extensions"}
ALLOWED_TOP_LEVEL = REQUIRED | OPTIONAL

TRUST_CLASSES = {"user", "system", "claude", "model", "worker"}

# Mirror of AgentIdentity allOf / BASE_CONFIDENCE_CEILING — keep in sync.
MAX_CEILING = {
    "user": 1.00,
    "system": 1.00,
    "claude": 0.40,
    "model": 0.40,
    "worker": 0.30,
}


class TrustContractError(ValueError):
    """Raised when an identity record violates a trust-contract invariant."""


def validate_identity(record: dict) -> None:
    """Validate a single AgentIdentity record against the security invariants.

    Raises TrustContractError on the first violation found.
    """
    if not isinstance(record, dict):
        raise TrustContractError("identity record must be an object")

    # (1) closed contract — no unknown top-level keys
    unknown = set(record) - ALLOWED_TOP_LEVEL
    if unknown:
        raise TrustContractError(
            f"unknown top-level field(s) {sorted(unknown)} — authority fields "
            f"may not be smuggled via additionalProperties; use 'extensions'"
        )

    missing = REQUIRED - set(record)
    if missing:
        raise TrustContractError(f"missing required field(s) {sorted(missing)}")

    # (2) trust_class enum
    tc = record["trust_class"]
    if tc not in TRUST_CLASSES:
        raise TrustContractError(f"trust_class {tc!r} not in {sorted(TRUST_CLASSES)}")

    # (3) confidence_ceiling within [0, per-class max]
    ceiling = record["confidence_ceiling"]
    if not isinstance(ceiling, (int, float)) or isinstance(ceiling, bool):
        raise TrustContractError("confidence_ceiling must be a number")
    if ceiling < 0:
        raise TrustContractError("confidence_ceiling must be >= 0")
    if ceiling > MAX_CEILING[tc]:
        raise TrustContractError(
            f"confidence_ceiling {ceiling} exceeds the maximum {MAX_CEILING[tc]} "
            f"for trust_class {tc!r}"
        )

    qw = record["quorum_weight"]
    if not isinstance(qw, (int, float)) or isinstance(qw, bool) or qw < 0:
        raise TrustContractError("quorum_weight must be a number >= 0")

    # (4) extensions, if present, must be an object
    if "extensions" in record and not isinstance(record["extensions"], dict):
        raise TrustContractError("extensions must be an object")


def _load(name: str) -> dict:
    with open(os.path.join(SCHEMA_DIR, "examples", name), encoding="utf-8") as fh:
        return json.load(fh)


# ── Tests ─────────────────────────────────────────────────────────────────────

def test_shipped_examples_are_valid():
    for name in ("claude.json", "worker.json"):
        validate_identity(_load(name))


def test_worker_ceiling_matches_enforced_max():
    # Regression: worker.json previously declared 0.60 > enforced 0.30.
    assert _load("worker.json")["confidence_ceiling"] <= MAX_CEILING["worker"]


def _base_record(**overrides) -> dict:
    rec = {
        "id": "test-agent",
        "name": "Test Agent",
        "trust_class": "claude",
        "domain_authorities": ["analysis"],
        "confidence_ceiling": 0.40,
        "quorum_weight": 0.50,
        "created_at": "2026-06-26T00:00:00.000Z",
        "registered_by": "alex",
    }
    rec.update(overrides)
    return rec


def _expect_reject(record, needle: str):
    try:
        validate_identity(record)
    except TrustContractError as err:
        assert needle in str(err), f"wrong rejection reason: {err}"
        return
    raise AssertionError(f"expected record to be rejected ({needle})")


def test_rejects_over_ceiling_for_class():
    # A model-class agent claiming user-level confidence headroom.
    _expect_reject(_base_record(trust_class="claude", confidence_ceiling=1.0), "exceeds")


def test_rejects_unknown_top_level_field():
    # additionalProperties: false — a smuggled override key is rejected.
    _expect_reject(_base_record(confidence_ceiling_override=1.0), "unknown top-level")


def test_rejects_unknown_trust_class():
    _expect_reject(_base_record(trust_class="root"), "not in")


def test_forward_compat_goes_in_extensions():
    # Non-authoritative metadata is accepted only inside extensions.
    validate_identity(_base_record(extensions={"experimental_tag": "beta", "anything": 1}))


def test_lower_than_max_ceiling_is_allowed():
    validate_identity(_base_record(trust_class="worker", confidence_ceiling=0.10))


# ── Runner ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except Exception as err:  # noqa: BLE001 — test runner surface
            failed += 1
            print(f"FAIL {t.__name__}: {err}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(1 if failed else 0)
