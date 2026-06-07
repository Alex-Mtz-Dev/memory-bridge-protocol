"""
Memory Bridge Protocol — Parliament reference resolver.

Implements the quorum-resolution spec for Parliament.v0.3 proposals.

Two responsibilities:
  1. resolve(proposal)            -> compute the weighted Resolution
  2. score_against_outcome(...)   -> after reality resolves the subject, turn each
                                     vote into a (voter, staked_confidence, was_correct)
                                     tuple to feed the calibration engine

Why weighted, not majority
--------------------------
A vote's effective weight is:

    effective_weight = quorum_weight x calibration_weight x domain_relevance x staked_confidence

  - quorum_weight       structural authority           (from AgentIdentity)
  - calibration_weight  earned track record            (Brier-derived; the flywheel)
  - domain_relevance    is this in the voter's lane?    (an out-of-lane agent barely counts)
  - staked_confidence   how much the voter commits      (the scored stake)

    weighted_consensus = support_weight / (support_weight + oppose_weight)

Abstentions count toward quorum participation but not toward support/oppose.
This aggregates predictions-with-skin-in-the-game, not raw preferences, which is
how it steps around Arrow's impossibility result.

Pure standard library.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

FORMULA = "quorum_weight * calibration_weight * domain_relevance * staked_confidence"

# Defaults applied when a vote omits an optional weighting field.
DEFAULT_QUORUM_WEIGHT = 0.5
DEFAULT_CALIBRATION_WEIGHT = 0.5
DEFAULT_DOMAIN_RELEVANCE = 1.0


def effective_weight(vote: dict, *, authority_scoping: bool = True) -> float:
    """Effective weight a single vote contributes. Abstentions still get a weight
    computed (useful for transparency) but are excluded from support/oppose sums."""
    qw = _num(vote.get("voter_quorum_weight"), DEFAULT_QUORUM_WEIGHT)
    cw = _num(vote.get("voter_calibration_weight"), DEFAULT_CALIBRATION_WEIGHT)
    dr = _num(vote.get("domain_relevance"), DEFAULT_DOMAIN_RELEVANCE) if authority_scoping else 1.0
    stake = _num(vote.get("staked_confidence"), 0.0)
    return qw * cw * dr * stake


# Epistemic status the subject moves to when a proposal of each type passes.
_RESULTING_STATUS = {
    "promote_belief": "verified",
    "quarantine_belief": "quarantined",
    "supersede_belief": "superseded",
    "commit_decision": "verified",
    "adjust_trust_weight": None,
    "custom": None,
}


def resolve(proposal: dict, *, now: datetime | None = None) -> dict:
    """Compute the Resolution for a proposal. Pure — returns a resolution dict,
    does not mutate the proposal."""
    now = now or datetime.now(timezone.utc)
    policy = proposal.get("quorum_policy", {}) or {}
    min_votes = int(policy.get("min_votes", 1))
    threshold = _num(policy.get("min_weighted_consensus"), 0.5)
    authority_scoping = bool(policy.get("authority_scoping", True))
    supermajority = policy.get("aggregation") == "supermajority_weighted"

    votes = proposal.get("votes", []) or []
    total_votes = len(votes)

    support_weight = 0.0
    oppose_weight = 0.0
    tally: list[dict] = []

    for v in votes:
        ew = effective_weight(v, authority_scoping=authority_scoping)
        pos = v.get("position", "abstain")
        tally.append({
            "voter_agent": v.get("voter_agent", "?"),
            "position": pos,
            "effective_weight": round(ew, 6),
        })
        if pos == "support":
            support_weight += ew
        elif pos == "oppose":
            oppose_weight += ew

    decisive = support_weight + oppose_weight
    weighted_consensus = (support_weight / decisive) if decisive > 0 else 0.0

    quorum_met = total_votes >= min_votes
    pass_bar = max(threshold, 0.6667) if supermajority else threshold

    if not quorum_met:
        outcome = "no_quorum"
    elif decisive == 0:
        outcome = "no_quorum"            # only abstentions — nothing decided
    elif abs(weighted_consensus - 0.5) < 1e-9:
        outcome = "tie"
    elif weighted_consensus >= pass_bar:
        outcome = "passed"
    else:
        outcome = "rejected"

    resolution = {
        "resolved_at": now.isoformat(),
        "outcome": outcome,
        "weighted_consensus": round(weighted_consensus, 4),
        "effective_weight_formula": FORMULA + (" [authority_scoping off]" if not authority_scoping else ""),
        "quorum_met": quorum_met,
        "total_votes": total_votes,
        "support_weight": round(support_weight, 6),
        "oppose_weight": round(oppose_weight, 6),
        "tally": tally,
    }

    resulting = _RESULTING_STATUS.get(proposal.get("proposal_type"))
    if outcome == "passed" and resulting:
        resolution["resulting_status"] = resulting

    return resolution


def score_against_outcome(proposal: dict, subject_was_correct: bool) -> list[tuple[str, float, bool]]:
    """
    After reality resolves the proposal's subject (the belief came true or didn't),
    score each non-abstaining vote for calibration feedback.

    A vote is 'correct' if the voter supported a subject that turned out true, or
    opposed one that turned out false.

    A stake is directional, so it must be converted to a probability before Brier
    scoring: staking s in the chosen direction implies probability (0.5 + s/2) on
    that direction. Returned tuples are ready for
    BeliefOverlay.register_outcome(agent, implied_confidence, was_correct):
    being wrong with a large stake is punished hard; being wrong with a small stake
    is barely punished; the same logic that makes the belief calibrator fair.

    This is the flywheel: vote -> outcome -> calibration_weight -> future vote weight.
    """
    results: list[tuple[str, float, bool]] = []
    for v in proposal.get("votes", []) or []:
        pos = v.get("position", "abstain")
        if pos == "abstain":
            continue
        supported = pos == "support"
        was_correct = (supported and subject_was_correct) or (not supported and not subject_was_correct)
        implied_confidence = 0.5 + _num(v.get("staked_confidence"), 0.0) / 2.0
        results.append((v.get("voter_agent", "?"), round(implied_confidence, 4), was_correct))
    return results


# ── helpers ─────────────────────────────────────────────────────────────────────

def _num(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
