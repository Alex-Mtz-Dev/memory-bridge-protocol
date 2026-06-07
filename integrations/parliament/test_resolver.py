"""
Memory Bridge Protocol — Parliament resolver conformance tests.

Run either way:
    python test_resolver.py        # plain asserts, prints PASS/FAIL
    pytest test_resolver.py        # standard pytest

Pins the quorum-resolution behavior so the spec stays honest across changes.
"""

from __future__ import annotations

from resolver import effective_weight, resolve, score_against_outcome

# ── Fixtures ──────────────────────────────────────────────────────────────────

def _vote(agent, position, stake, qw=0.5, cw=0.5, dr=1.0):
    return {
        "voter_agent": agent, "voter_trust_class": "model", "position": position,
        "staked_confidence": stake, "voter_quorum_weight": qw,
        "voter_calibration_weight": cw, "domain_relevance": dr,
    }

def _proposal(votes, ptype="promote_belief", min_votes=3, threshold=0.60, scoping=True):
    return {
        "proposal_id": "p", "proposal_type": ptype, "subject_ref": "b", "proposition": "x",
        "proposed_by": "a", "created_at": "2026-06-05T00:00:00Z", "status": "open",
        "quorum_policy": {"min_votes": min_votes, "min_weighted_consensus": threshold,
                          "authority_scoping": scoping},
        "votes": votes,
    }


# ── Tests ───────────────────────────────────────────────────────────────────────

def test_effective_weight_is_product():
    w = effective_weight(_vote("a", "support", 0.40, qw=0.8, cw=0.79, dr=1.0))
    assert abs(w - (0.8 * 0.79 * 1.0 * 0.40)) < 1e-9

def test_authority_scoping_shrinks_out_of_lane_votes():
    in_lane = effective_weight(_vote("a", "support", 0.40, qw=0.6, cw=0.70, dr=1.0))
    out_lane = effective_weight(_vote("a", "support", 0.40, qw=0.6, cw=0.70, dr=0.25))
    assert out_lane < in_lane
    assert abs(out_lane - in_lane * 0.25) < 1e-9

def test_scoping_off_ignores_domain_relevance():
    w = effective_weight(_vote("a", "support", 0.40, dr=0.1), authority_scoping=False)
    full = effective_weight(_vote("a", "support", 0.40, dr=1.0), authority_scoping=False)
    assert abs(w - full) < 1e-9

def test_weighted_consensus_not_majority():
    # 3 weak supporters vs 1 strong, well-calibrated, in-lane opposer.
    votes = [
        _vote("s1", "support", 0.30, qw=0.4, cw=0.4, dr=0.5),
        _vote("s2", "support", 0.30, qw=0.4, cw=0.4, dr=0.5),
        _vote("s3", "support", 0.30, qw=0.4, cw=0.4, dr=0.5),
        _vote("opp", "oppose", 0.95, qw=0.95, cw=0.95, dr=1.0),
    ]
    res = resolve(_proposal(votes))
    # Majority (3:1) supports, but weight favors the opposer -> not a runaway pass.
    assert res["weighted_consensus"] < 0.6
    assert res["outcome"] == "rejected"

def test_quarantine_unanimous_passes():
    votes = [
        _vote("macro", "support", 0.40, qw=0.6, cw=0.70, dr=1.0),
        _vote("risk", "support", 0.40, qw=0.7, cw=0.72, dr=0.9),
        _vote("eq", "abstain", 0.0, dr=0.2),
        _vote("pf", "support", 0.35, qw=0.75, cw=0.68, dr=0.6),
    ]
    res = resolve(_proposal(votes, ptype="quarantine_belief"))
    assert res["outcome"] == "passed"
    assert res["weighted_consensus"] == 1.0
    assert res["resulting_status"] == "quarantined"

def test_abstention_counts_for_quorum_not_consensus():
    votes = [
        _vote("a", "support", 0.5, qw=0.6, cw=0.6, dr=1.0),
        _vote("b", "support", 0.5, qw=0.6, cw=0.6, dr=1.0),
        _vote("c", "abstain", 0.0),
    ]
    res = resolve(_proposal(votes, min_votes=3))
    assert res["quorum_met"] is True          # 3 votes incl. abstention
    assert res["total_votes"] == 3
    assert res["weighted_consensus"] == 1.0    # abstention excluded from ratio

def test_below_min_votes_is_no_quorum():
    res = resolve(_proposal([_vote("a", "support", 0.9)], min_votes=3))
    assert res["outcome"] == "no_quorum"

def test_only_abstentions_is_no_quorum():
    votes = [_vote("a", "abstain", 0.0), _vote("b", "abstain", 0.0), _vote("c", "abstain", 0.0)]
    res = resolve(_proposal(votes, min_votes=3))
    assert res["outcome"] == "no_quorum"

def test_stake_maps_to_implied_probability():
    # support stake 0.40 -> implied P(true) = 0.70
    p = _proposal([_vote("a", "support", 0.40)])
    scored = score_against_outcome(p, subject_was_correct=True)
    assert scored[0][0] == "a"
    assert abs(scored[0][1] - 0.70) < 1e-9
    assert scored[0][2] is True

def test_opposer_of_true_subject_scored_incorrect():
    p = _proposal([_vote("opp", "oppose", 0.35), _vote("sup", "support", 0.40)])
    scored = dict((a, (c, ok)) for a, c, ok in score_against_outcome(p, subject_was_correct=True))
    assert scored["opp"][1] is False   # opposed a true subject -> wrong
    assert scored["sup"][1] is True    # supported a true subject -> right

def test_abstainers_not_scored():
    p = _proposal([_vote("a", "abstain", 0.0), _vote("b", "support", 0.5)])
    scored = score_against_outcome(p, subject_was_correct=True)
    assert [s[0] for s in scored] == ["b"]


# ── Plain-python runner ──────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS  {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
