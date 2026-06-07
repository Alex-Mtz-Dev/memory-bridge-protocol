"""
Memory Bridge Protocol — read-only belief overlay.

DESIGN PRINCIPLE — READ ONLY.
This overlay sits BESIDE your memory store (Mem0, Zep, Letta, ...), never in its
write path. It ingests memory records, wraps them as Belief Envelopes, and scores
them for decay, reality-drift, contamination, and source calibration. It produces
a risk view. It never mutates the underlying store.

That is the whole point: a hedge fund can drop this next to its live research
process on day one, because it cannot break anything. Governance as observation
first; enforcement only once trust is earned.

Pure standard library. The only thing you must supply for full value is a
`reconciler` — a callable that marks a belief to your realized market/outcome
data. Everything else (decay, immune checks, Brier calibration) runs out of the box.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

# ── Tunable thresholds ─────────────────────────────────────────────────────────
GHOST_EVIDENCE_THRESHOLD = 0.25     # below this, a belief has no real support
DRIFT_QUARANTINE_THRESHOLD = 0.70   # above this, realized data contradicts the belief
IMMUNE_SWEEP_FLOOR = 0.20           # the bridge sweeps beliefs below this confidence
METABOLIC_FLOOR = 0.10              # absolute confidence floor

# A reconciler marks a belief to reality and returns a drift score in [0, 1].
# The fund supplies this — it needs their market/outcome data. None = skip drift.
Reconciler = Callable[[dict], float | None]


# ── Pure scoring functions (no state) ───────────────────────────────────────────

def parse_iso8601_duration_days(duration: str) -> float:
    """Minimal ISO-8601 duration parser for the day-scale half-lives we use (P3D, P30D, P365D, PT12H)."""
    if not duration:
        return 0.0
    m = re.fullmatch(r"P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", duration)
    if not m:
        return 0.0
    years, months, days, hours, mins, secs = (int(x) if x else 0 for x in m.groups())
    return years * 365 + months * 30 + days + hours / 24 + mins / 1440 + secs / 86400


def effective_confidence(confidence: float, half_life_days: float, age_days: float) -> float:
    """Exponential metabolic decay: C(t) = C0 * 2^(-age/half_life), floored."""
    if half_life_days <= 0:
        return confidence
    decayed = confidence * math.pow(2.0, -age_days / half_life_days)
    return max(METABOLIC_FLOOR, decayed)


def detect_pathogens(belief: dict) -> list[str]:
    """
    Immune-system checks. Returns a list of detected pathogen flags:
      - ghost_belief       : evidence_score below threshold (no real support)
      - citation_loop      : evidence chain terminates in agent-generated content
      - reality_divergence : truth_drift exceeds the quarantine threshold
    """
    flags: list[str] = []
    ev = belief.get("evidence", {}) or {}
    if ev.get("evidence_score", 1.0) < GHOST_EVIDENCE_THRESHOLD:
        flags.append("ghost_belief")
    if ev.get("chain_terminates_in_agent_content"):
        flags.append("citation_loop")
    drift = (belief.get("reality_check", {}) or {}).get("truth_drift_score")
    if drift is not None and drift > DRIFT_QUARANTINE_THRESHOLD:
        flags.append("reality_divergence")
    return flags


def brier_calibration_weight(resolved: list[tuple[float, bool]]) -> float:
    """
    Derive a trust weight from realized outcomes via the Brier score.
    `resolved` = list of (asserted_confidence, was_correct).
    Brier in [0,1] (0 = perfect); trust = 1 - Brier. Neutral prior 0.5 if no data.
    """
    if not resolved:
        return 0.5
    brier = sum((c - (1.0 if hit else 0.0)) ** 2 for c, hit in resolved) / len(resolved)
    return round(max(0.0, 1.0 - brier), 4)


# ── The overlay ─────────────────────────────────────────────────────────────────

@dataclass
class BeliefAssessment:
    belief_id: str
    proposition: str
    source_agent: str
    asserted_confidence: float
    effective_confidence: float
    truth_drift: float | None
    pathogens: list[str]
    recommended_status: str
    review_priority: float  # 0 (ignore) .. 1 (urgent)


@dataclass
class BeliefOverlay:
    """
    Read-only governance overlay over an existing memory store.

    reconciler : optional callable(belief)->drift[0..1]; supply your market/outcome
                 reconciliation here. If omitted, reality_check.truth_drift_score on
                 the envelope is used as-is and no live marking is attempted.
    """
    reconciler: Reconciler | None = None
    _resolved_by_agent: dict[str, list[tuple[float, bool]]] = field(default_factory=dict)

    # --- ingestion -------------------------------------------------------------

    def ingest_mem0(self, record: dict, *, source_agent: str, source_trust_class: str = "model") -> dict:
        """
        Wrap a raw Mem0 record into a Belief Envelope (read-only — the Mem0 record
        is not modified). Mem0 records look roughly like:
            {"id": "...", "memory": "text", "metadata": {...}, "created_at": "..."}
        Map whatever fields you have; unknown fields fall back to sensible defaults.
        """
        meta = record.get("metadata", {}) or {}
        return {
            "belief_id": record.get("id") or f"belief_{abs(hash(record.get('memory',''))) % 10**8}",
            "proposition": record.get("memory") or record.get("text") or "",
            "cell_type": meta.get("cell_type", "fact"),
            "source_agent": source_agent,
            "source_trust_class": source_trust_class,
            "confidence": float(meta.get("confidence", 0.40)),
            "epistemic_status": meta.get("epistemic_status", "inferred"),
            "created_at": record.get("created_at") or _now_iso(),
            "evidence": {
                "refs": meta.get("evidence_refs", []),
                "evidence_score": float(meta.get("evidence_score", 0.5)),
                "chain_terminates_in_agent_content": bool(meta.get("agent_sourced", False)),
            },
            "decay": {
                "model": "exponential",
                "half_life": meta.get("half_life", "P30D"),
            },
            "reality_check": {
                "truth_drift_score": meta.get("truth_drift_score"),
                "drift_data_ref": meta.get("drift_data_ref"),
            },
            "thread_id": meta.get("thread_id", "default"),
        }

    # --- outcome tracking (for calibration) ------------------------------------

    def register_outcome(self, source_agent: str, asserted_confidence: float, was_correct: bool) -> None:
        """Record a resolved belief outcome so the agent's trust weight recalibrates."""
        self._resolved_by_agent.setdefault(source_agent, []).append((asserted_confidence, was_correct))

    def agent_trust_weight(self, source_agent: str) -> float:
        """Current calibration-derived trust weight for an agent (Brier-based)."""
        return brier_calibration_weight(self._resolved_by_agent.get(source_agent, []))

    # --- assessment ------------------------------------------------------------

    def assess(self, belief: dict, *, now: datetime | None = None) -> BeliefAssessment:
        """Score a single belief. Pure read — returns an assessment, mutates nothing."""
        now = now or datetime.now(timezone.utc)
        created = _parse_dt(belief["created_at"])
        age_days = max(0.0, (now - created).total_seconds() / 86400)

        half_life_days = parse_iso8601_duration_days((belief.get("decay", {}) or {}).get("half_life", ""))
        eff = effective_confidence(float(belief.get("confidence", 0.0)), half_life_days, age_days)

        # Mark to reality if a reconciler is wired; else use the envelope's drift.
        drift = None
        if self.reconciler is not None:
            drift = self.reconciler(belief)
        if drift is None:
            drift = (belief.get("reality_check", {}) or {}).get("truth_drift_score")

        # Rising drift accelerates decay (mark-to-market beats clock-decay).
        if drift is not None:
            eff = max(METABOLIC_FLOOR, eff * (1.0 - drift))

        # temporarily attach drift so pathogen detection sees the live value
        probe = {**belief, "reality_check": {**(belief.get("reality_check") or {}), "truth_drift_score": drift}}
        pathogens = detect_pathogens(probe)

        recommended = _recommend_status(belief, eff, pathogens)
        priority = _review_priority(eff, drift, pathogens)

        return BeliefAssessment(
            belief_id=belief["belief_id"],
            proposition=belief["proposition"],
            source_agent=belief["source_agent"],
            asserted_confidence=float(belief.get("confidence", 0.0)),
            effective_confidence=round(eff, 4),
            truth_drift=drift,
            pathogens=pathogens,
            recommended_status=recommended,
            review_priority=round(priority, 3),
        )

    def risk_summary(self, beliefs: Iterable[dict], *, now: datetime | None = None) -> dict:
        """
        The CRO dashboard. Aggregates assessments into a single risk view.
        Read-only — returns a report; nothing is written back to the store.
        """
        assessments = [self.assess(b, now=now) for b in beliefs]
        total = len(assessments)
        quarantine = [a for a in assessments if "reality_divergence" in a.pathogens or "ghost_belief" in a.pathogens]
        decaying = [a for a in assessments if a.effective_confidence < IMMUNE_SWEEP_FLOOR]
        contaminated = [a for a in assessments if "citation_loop" in a.pathogens]

        # A belief is "healthy" if it is neither a quarantine candidate nor decaying.
        # Sets overlap, so subtract the union (not the sum) to avoid double-counting.
        flagged = {a.belief_id for a in quarantine} | {a.belief_id for a in decaying}

        return {
            "total_beliefs": total,
            "healthy": total - len(flagged),
            "decaying_below_sweep_floor": len(decaying),
            "quarantine_candidates": len(quarantine),
            "citation_loop_flags": len(contaminated),
            "top_review_queue": [
                {
                    "belief_id": a.belief_id,
                    "proposition": a.proposition[:90],
                    "source_agent": a.source_agent,
                    "effective_confidence": a.effective_confidence,
                    "truth_drift": a.truth_drift,
                    "pathogens": a.pathogens,
                    "recommended_status": a.recommended_status,
                }
                for a in sorted(assessments, key=lambda x: x.review_priority, reverse=True)[:10]
            ],
            "agent_trust_weights": {
                agent: self.agent_trust_weight(agent) for agent in self._resolved_by_agent
            },
        }


# ── Internal helpers ─────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_dt(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _recommend_status(belief: dict, eff_conf: float, pathogens: list[str]) -> str:
    if "ghost_belief" in pathogens or "reality_divergence" in pathogens:
        return "quarantined"
    if eff_conf < IMMUNE_SWEEP_FLOOR:
        return "superseded"
    if "citation_loop" in pathogens:
        return "contested"
    return belief.get("epistemic_status", "inferred")


def _review_priority(eff_conf: float, drift: float | None, pathogens: list[str]) -> float:
    score = 0.0
    if "reality_divergence" in pathogens:
        score += 0.5
    if "ghost_belief" in pathogens:
        score += 0.3
    if "citation_loop" in pathogens:
        score += 0.2
    if drift is not None:
        score += 0.4 * drift
    score += 0.2 * (1.0 - eff_conf)  # low effective confidence = needs a look
    return min(1.0, score)
