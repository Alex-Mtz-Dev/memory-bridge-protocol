"""
Memory Bridge Protocol — Parliament demo.

Resolves two proposals with weighted aggregation, then closes the flywheel:
after reality resolves a belief, each vote is scored and fed into the calibration
engine, changing every voter's future weight.

No external services. If the mem0-overlay is on the path, the demo hands the
scored votes to its BeliefOverlay to show the real calibration update; otherwise
it computes the same Brier weights inline.

Run:
    python example_vote.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

from resolver import resolve, score_against_outcome

NOW = datetime(2026, 6, 5, 16, 0, tzinfo=timezone.utc)

# ── Try to use the real calibration engine from the mem0-overlay ─────────────────
_OVERLAY_PATH = os.path.join(os.path.dirname(__file__), "..", "integrations", "mem0-overlay")
sys.path.insert(0, os.path.abspath(_OVERLAY_PATH))
try:
    from overlay import BeliefOverlay, brier_calibration_weight  # type: ignore
    HAVE_OVERLAY = True
except Exception:
    HAVE_OVERLAY = False
    def brier_calibration_weight(resolved):  # fallback, identical math
        if not resolved:
            return 0.5
        brier = sum((c - (1.0 if hit else 0.0)) ** 2 for c, hit in resolved) / len(resolved)
        return round(max(0.0, 1.0 - brier), 4)


# ── Proposal 1: promote the NVDA margin belief (demonstrates authority scoping) ──
PROMOTE_NVDA = {
    "proposal_id": "prop_promote_nvda_fy27",
    "proposal_type": "promote_belief",
    "subject_ref": "belief_nvda_margin_fy27",
    "proposition": "Promote 'NVIDIA data-center gross-margin expansion continues through FY2027' from inferred to verified.",
    "domain": ["semiconductors", "equity-valuation"],
    "proposed_by": "equity_research_agent",
    "created_at": "2026-06-05T15:30:00Z",
    "quorum_policy": {
        "min_votes": 3,
        "min_weighted_consensus": 0.60,
        "aggregation": "weighted_consensus",
        "authority_scoping": True,
    },
    "votes": [
        {"voter_agent": "equity_research_agent", "voter_trust_class": "model", "position": "support",
         "staked_confidence": 0.40, "voter_quorum_weight": 0.80, "voter_calibration_weight": 0.79,
         "domain_relevance": 1.00, "rationale": "Two consecutive prints confirm the trend."},
        {"voter_agent": "risk_agent", "voter_trust_class": "model", "position": "oppose",
         "staked_confidence": 0.35, "voter_quorum_weight": 0.70, "voter_calibration_weight": 0.72,
         "domain_relevance": 0.80, "rationale": "Forward guidance leaves room for compression."},
        {"voter_agent": "macro_agent_v4", "voter_trust_class": "model", "position": "support",
         "staked_confidence": 0.40, "voter_quorum_weight": 0.60, "voter_calibration_weight": 0.70,
         "domain_relevance": 0.25, "rationale": "Rates backdrop supportive."},  # out of lane
        {"voter_agent": "portfolio_agent", "voter_trust_class": "model", "position": "support",
         "staked_confidence": 0.30, "voter_quorum_weight": 0.75, "voter_calibration_weight": 0.68,
         "domain_relevance": 0.70, "rationale": "Consistent with position thesis."},
    ],
    "status": "open",
}

# ── Proposal 2: quarantine the ghost belief (unanimous, with an abstention) ──────
QUARANTINE_GHOST = {
    "proposal_id": "prop_quarantine_ghost_4cuts",
    "proposal_type": "quarantine_belief",
    "subject_ref": "belief_ghost_4cuts",
    "proposition": "Quarantine 'Market consensus expects four Fed rate cuts before Q4' — no evidence, contradicted by futures.",
    "domain": ["macroeconomics", "rates"],
    "proposed_by": "risk_agent",
    "created_at": "2026-06-05T15:40:00Z",
    "quorum_policy": {"min_votes": 3, "min_weighted_consensus": 0.60, "authority_scoping": True},
    "votes": [
        {"voter_agent": "macro_agent_v4", "voter_trust_class": "model", "position": "support",
         "staked_confidence": 0.40, "voter_quorum_weight": 0.60, "voter_calibration_weight": 0.70,
         "domain_relevance": 1.00, "rationale": "Concede — the futures curve disagrees."},
        {"voter_agent": "risk_agent", "voter_trust_class": "model", "position": "support",
         "staked_confidence": 0.40, "voter_quorum_weight": 0.70, "voter_calibration_weight": 0.72,
         "domain_relevance": 0.90, "rationale": "Zero evidence chain; clear ghost."},
        {"voter_agent": "equity_research_agent", "voter_trust_class": "model", "position": "abstain",
         "staked_confidence": 0.00, "domain_relevance": 0.20, "rationale": "Out of my domain."},
        {"voter_agent": "portfolio_agent", "voter_trust_class": "model", "position": "support",
         "staked_confidence": 0.35, "voter_quorum_weight": 0.75, "voter_calibration_weight": 0.68,
         "domain_relevance": 0.60},
    ],
    "status": "open",
}


def show_resolution(proposal: dict) -> dict:
    res = resolve(proposal, now=NOW)
    print(f"\n━━━ {proposal['proposal_id']} ({proposal['proposal_type']}) ━━━")
    print(f"  {proposal['proposition'][:88]}")
    print(f"  outcome: {res['outcome'].upper()}   weighted_consensus: {res['weighted_consensus']}"
          f"   quorum_met: {res['quorum_met']}")
    if "resulting_status" in res:
        print(f"  subject → {res['resulting_status']}")
    print("  tally (effective weights):")
    for t in res["tally"]:
        print(f"     {t['voter_agent']:24s} {t['position']:8s} w={t['effective_weight']}")
    return res


def main() -> None:
    print("Calibration engine:", "mem0-overlay BeliefOverlay" if HAVE_OVERLAY else "inline fallback")

    show_resolution(PROMOTE_NVDA)
    note = ("  Note: macro_agent_v4 supported but is out of lane (domain_relevance 0.25),\n"
            "  so its effective weight is tiny — authority scoping working as intended.")
    print(note)

    show_resolution(QUARANTINE_GHOST)
    print("  Note: equity_research_agent abstained — counts toward quorum (4 votes),\n"
          "  but not toward the consensus ratio.")

    # ── Close the flywheel: NVDA belief later proves TRUE ────────────────────────
    print("\n\n━━━ Flywheel: reality resolves belief_nvda_margin_fy27 = TRUE ━━━")
    scored = score_against_outcome(PROMOTE_NVDA, subject_was_correct=True)
    print("  votes scored against the realized outcome (stake → implied P(position)):")
    for agent, implied_conf, correct in scored:
        print(f"     {agent:24s} P(position)={implied_conf:.3f}  correct={correct}")

    # Feed into the calibration engine (existing track records seeded for illustration).
    seed = {
        "equity_research_agent": [(0.40, True), (0.55, True)],
        "risk_agent": [(0.60, True), (0.50, True)],
        "macro_agent_v4": [(0.70, False), (0.50, True)],
        "portfolio_agent": [(0.45, True)],
    }

    print("\n  trust weight change (Brier-derived):")
    for agent, history in seed.items():
        before = brier_calibration_weight(history)
        # append this proposal's outcome for the agent
        new_points = [(s, c) for a, s, c in scored if a == agent]
        after = brier_calibration_weight(history + new_points)
        arrow = "↑" if after > before else ("↓" if after < before else "→")
        print(f"     {agent:24s} {before:.3f} {arrow} {after:.3f}")

    print("\n  risk_agent opposed a belief that proved true → its weight ticks down.")
    print("  Supporters who were right gain. Next time they vote, they count for more.")
    print("  That is the moat: weight is earned from outcomes, not assigned.")


if __name__ == "__main__":
    main()
