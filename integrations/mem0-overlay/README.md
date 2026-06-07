# Memory Bridge Protocol — read-only belief overlay for Mem0

Drop a governance layer **beside** an existing Mem0 research stack — never in its
write path. The overlay ingests memories, wraps them as
[Belief Envelopes](../../schemas/BeliefEnvelope.v0.1.json), and scores them for
decay, reality-drift, contamination, and source calibration. It produces a risk
view; it never mutates the underlying store.

That read-only posture is the point. A hedge fund (or any team that can't risk
its memory pipeline) can run this against live research on day one, because it
cannot break anything. Governance as observation first; enforcement only once
trust is earned.

## Why an overlay, not a rewrite

The instinct is to route every Mem0 write through a governance schema. For a fund
that's a non-starter — you'd be sitting in the critical path of the process that
makes their money. The overlay inverts it: read their memories, score them, surface
the risk. Lower adoption risk, faster pilot, same wedge.

## What it scores

| Dimension | Mechanism | The failure it catches |
|---|---|---|
| **Decay** | Exponential half-life by info type (rumor P3D → filing P365D) | Stale theses outliving their relevance |
| **Reality drift** | Mark-to-market vs realized data (`truth_drift_score`) | A belief the market has already contradicted |
| **Ghost beliefs** | `evidence_score` below threshold | Synthetic conclusions cited as fact |
| **Citation loops** | Evidence chain terminates in agent content | Consensus contamination / recursive collapse |
| **Calibration** | Brier score over resolved outcomes | Overconfident agents quietly losing trust weight |

Reality drift and calibration are the two a generic memory tool **cannot** do —
they require ground truth (market data, realized outcomes), which a fund has.
That's the defensible part.

## Run the demo

```bash
python example_hedge_fund.py
```

It loads four mock research memories (a well-supported NVIDIA thesis, a ghost
"4 rate cuts" belief, an Apple filing fact, and a busted oil thesis), registers
some resolved outcomes, and prints the belief-book risk summary. Expected: the
ghost belief and the oil thesis surface as quarantine candidates, and the
overconfident macro agent's trust weight drops.

## Use it on your own store

```python
from overlay import BeliefOverlay

overlay = BeliefOverlay(reconciler=my_market_reconciler)  # reconciler optional

# wrap a Mem0 record (read-only — the record is not modified)
belief = overlay.ingest_mem0(mem0_record, source_agent="equity_research_agent")

# score one belief
assessment = overlay.assess(belief)

# the CRO dashboard over the whole book
summary = overlay.risk_summary(all_beliefs)
```

### Wiring reality (the differentiator)

`BeliefOverlay(reconciler=...)` takes a callable `belief -> drift[0..1]`. This is
where you mark beliefs to *your* data — compare the proposition against the series
in `reality_check.drift_data_ref` and return how far reality has moved. Without a
reconciler, the overlay uses whatever `truth_drift_score` is already on the
envelope, so the demo runs with no data connection.

### Calibration

Call `overlay.register_outcome(agent, asserted_confidence, was_correct)` whenever a
belief resolves (from realized P&L). `overlay.agent_trust_weight(agent)` then
returns a Brier-derived trust weight — **earned from outcomes, not assigned**. Being
wrong at low confidence is barely penalized; being wrong at high confidence is
punished hard. That's the behavior you want.

## Thresholds

Tune at the top of `overlay.py`:

```python
GHOST_EVIDENCE_THRESHOLD   = 0.25   # below = no real support
DRIFT_QUARANTINE_THRESHOLD = 0.70   # above = reality contradicts the belief
IMMUNE_SWEEP_FLOOR         = 0.20   # bridge sweeps below this confidence
METABOLIC_FLOOR            = 0.10   # absolute confidence floor
```

## Files

```
overlay.py             # the read-only overlay engine (pure stdlib)
example_hedge_fund.py  # worked demo with mock Mem0 research memories
requirements.txt       # stdlib-only core; mem0ai optional
```

## Reference

→ [Belief Envelope v0.1 schema](../../schemas/BeliefEnvelope.v0.1.json)
→ [Examples](../../schemas/examples/)
→ [Memory Bridge Protocol](https://github.com/Alex-Mtz-Dev/memory-bridge-protocol)
