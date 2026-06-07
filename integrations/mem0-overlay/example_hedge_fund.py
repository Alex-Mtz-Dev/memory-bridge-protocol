"""
Memory Bridge Protocol — hedge-fund overlay demo.

Simulates a fleet of research agents writing to Mem0, then runs the READ-ONLY
belief overlay over their memories to surface drift, decay, contamination, and
calibration — the exact risk view a CRO would want over an agent research process.

No external services, no API keys. Pure illustration of the scoring.

Run:
    python example_hedge_fund.py
"""

from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta

from overlay import BeliefOverlay

NOW = datetime(2026, 6, 5, 15, 0, tzinfo=timezone.utc)


# ── Mock Mem0 research memories (what your agents already wrote) ──────────────────
# Shape mirrors a Mem0 record: id, memory (text), metadata, created_at.

MEM0_RECORDS = [
    {
        "id": "belief_nvda_margin_fy27",
        "memory": "NVIDIA data-center gross-margin expansion continues through FY2027.",
        "created_at": "2026-05-30T14:30:00Z",
        "metadata": {
            "confidence": 0.40,
            "evidence_refs": ["sec:NVDA-10Q-2026Q1", "transcript:NVDA-earnings-2026Q1"],
            "evidence_score": 0.84,
            "half_life": "P30D",
            "truth_drift_score": 0.18,
            "drift_data_ref": "series:NVDA-gross-margin-quarterly",
            "thread_id": "equity-research",
        },
    },
    {
        "id": "belief_ghost_4cuts",
        "memory": "Market consensus expects four Fed rate cuts before Q4.",
        "created_at": "2026-05-20T09:15:00Z",
        "metadata": {
            "confidence": 0.40,
            "evidence_refs": [],          # no sources
            "evidence_score": 0.06,        # ghost-belief territory
            "agent_sourced": True,         # chain terminates in agent content
            "half_life": "P14D",
            "truth_drift_score": 0.82,     # futures contradict it
            "drift_data_ref": "series:fed-funds-futures-implied-cuts",
            "thread_id": "macro-research",
        },
    },
    {
        "id": "belief_aapl_sec_fact",
        "memory": "Apple reported $XX.X B services revenue in its most recent 10-Q.",
        "created_at": "2026-05-01T00:00:00Z",
        "metadata": {
            "confidence": 0.95,            # a filing fact (user-verified)
            "evidence_refs": ["sec:AAPL-10Q-2026Q2"],
            "evidence_score": 0.98,
            "half_life": "P365D",          # filing facts decay slowly
            "truth_drift_score": 0.02,
            "thread_id": "equity-research",
        },
    },
    {
        "id": "belief_oil_above_100",
        "memory": "Crude oil will trade above $100 by end of quarter.",
        "created_at": "2026-04-15T00:00:00Z",
        "metadata": {
            "confidence": 0.40,
            "evidence_refs": ["internal:commodities-note-12"],
            "evidence_score": 0.55,
            "half_life": "P14D",           # trading thesis, short half-life
            "truth_drift_score": 0.74,     # oil is ~$68; reality diverged
            "drift_data_ref": "series:CL1-front-month",
            "thread_id": "commodities",
        },
    },
]

# Which agent wrote which memory (in production this comes from AgentIdentity).
SOURCE = {
    "belief_nvda_margin_fy27": ("equity_research_agent", "model"),
    "belief_ghost_4cuts": ("macro_agent_v4", "model"),
    "belief_aapl_sec_fact": ("filings_agent", "user"),   # human-verified ingest
    "belief_oil_above_100": ("commodities_agent", "model"),
}


def main() -> None:
    overlay = BeliefOverlay()  # no reconciler wired -> uses envelope drift values

    # 1. Ingest Mem0 records into Belief Envelopes (read-only wrap)
    beliefs = []
    for rec in MEM0_RECORDS:
        agent, trust = SOURCE[rec["id"]]
        beliefs.append(overlay.ingest_mem0(rec, source_agent=agent, source_trust_class=trust))

    # 2. Register some resolved outcomes so trust weights calibrate.
    #    (asserted_confidence, was_correct) — these come from realized P&L over time.
    overlay.register_outcome("equity_research_agent", 0.40, True)
    overlay.register_outcome("equity_research_agent", 0.55, True)
    overlay.register_outcome("equity_research_agent", 0.60, True)
    overlay.register_outcome("macro_agent_v4", 0.40, False)   # the 4-cuts miss
    overlay.register_outcome("macro_agent_v4", 0.70, False)   # overconfident + wrong
    overlay.register_outcome("macro_agent_v4", 0.50, True)
    overlay.register_outcome("commodities_agent", 0.40, False)

    # 3. Per-belief assessment
    print("━━━ Per-belief assessment (read-only) ━━━\n")
    for b in beliefs:
        a = overlay.assess(b, now=NOW)
        drift = f"{a.truth_drift:.2f}" if a.truth_drift is not None else "—"
        print(f"  {a.belief_id}")
        print(f"     {a.proposition[:70]}")
        print(f"     conf {a.asserted_confidence:.2f} → effective {a.effective_confidence:.2f}"
              f"  | drift {drift}  | priority {a.review_priority:.2f}")
        print(f"     pathogens: {a.pathogens or 'none'}  → recommend: {a.recommended_status}\n")

    # 4. The CRO dashboard
    print("━━━ Belief-book risk summary ━━━")
    summary = overlay.risk_summary(beliefs, now=NOW)
    print(json.dumps(summary, indent=2))

    print("\n━━━ Read of the book ━━━")
    print("  • Ghost belief (4 cuts) and the oil thesis are quarantine candidates —")
    print("    no/low evidence and reality has moved against them.")
    print("  • macro_agent_v4's trust weight is now the lowest: overconfident and wrong.")
    print("  • The AAPL filing fact stays healthy: human-verified, slow decay, aligned.")
    print("  • Nothing was written back to Mem0. This is a risk lens, not a gate.")


if __name__ == "__main__":
    main()
