# Memory Bridge Protocol — Parliament (v0.3)

Multi-agent governance for durable belief state. A **Proposal** to change governed
state (promote a belief, quarantine it, commit a decision) is put to a weighted
vote. Parliament does **not** use majority rule. A vote is a **stake**: the voter
commits confidence that is later scored against the realized outcome, and that
score moves the voter's future weight.

→ Schema: [`schemas/Parliament.v0.3.json`](../schemas/Parliament.v0.3.json)
→ Examples: [`proposal-promote-belief.json`](../schemas/examples/proposal-promote-belief.json), [`proposal-quarantine.json`](../schemas/examples/proposal-quarantine.json)

## Why not majority rule

Arrow's impossibility theorem says there's no perfect way to aggregate competing
*preferences*. So Parliament doesn't aggregate preferences — it aggregates
*predictions with skin in the game*. Each vote's effective weight is:

```
effective_weight = quorum_weight × calibration_weight × domain_relevance × staked_confidence
```

| Factor | Source | What it encodes |
|---|---|---|
| `quorum_weight` | AgentIdentity | structural authority |
| `calibration_weight` | Belief Envelope (Brier-derived) | earned track record — the flywheel |
| `domain_relevance` | proposal domain × voter authorities | is this in the voter's lane? |
| `staked_confidence` | the vote | how much the voter commits |

```
weighted_consensus = support_weight / (support_weight + oppose_weight)
```

Abstentions count toward quorum participation but not toward the consensus ratio.
A proposal passes when `quorum_met` **and** `weighted_consensus ≥ min_weighted_consensus`.

The practical effect: a confident, well-calibrated, in-lane minority can defeat a
weak majority. The conformance suite pins this exact case (`test_weighted_consensus_not_majority`).

## The flywheel (the part that compounds)

This is what makes the moat hard rather than soft:

```
vote ──▶ proposal resolves ──▶ reality resolves the subject
                                        │
              calibration_weight ◀──────┘  (Brier over outcomes)
                     │
                     ▼
            future vote weight changes
```

When a belief's subject resolves in reality, `score_against_outcome` turns each
vote into a `(voter, implied_confidence, was_correct)` tuple and feeds it to the
calibration engine. A directional stake becomes a probability first — staking 0.40
*in support* implies P(true) = 0.70 — so being wrong with a big stake is punished
hard, and being wrong with a small stake barely matters. Agents earn their weight
from outcomes; nobody assigns it.

## Run it

```bash
python example_vote.py      # resolve two proposals + show the flywheel
python test_resolver.py     # 11-test conformance suite (or: pytest test_resolver.py)
```

The demo, if the [`mem0-overlay`](../integrations/mem0-overlay/) is on the path,
hands scored votes to its real `BeliefOverlay` calibrator; otherwise it uses an
identical inline Brier computation.

## Use it

```python
from resolver import resolve, score_against_outcome

resolution = resolve(proposal)          # compute the weighted outcome
# ... later, once the subject resolves in reality:
for agent, conf, correct in score_against_outcome(proposal, subject_was_correct=True):
    overlay.register_outcome(agent, conf, correct)   # close the loop
```

## Proposal lifecycle

```
open ──(votes accumulate)──▶ resolve() ──▶ resolved
                                              ├─ passed     → subject transitions (e.g. → verified | quarantined)
                                              ├─ rejected
                                              ├─ no_quorum   (too few votes, or all abstentions)
                                              └─ tie
```

## Files

```
resolver.py         # weighted-consensus aggregation + outcome scoring (pure stdlib)
example_vote.py     # two worked proposals + the calibration flywheel
test_resolver.py    # conformance suite (plain python or pytest)
```

## Reference

→ [AgentIdentity v0.2](../schemas/AgentIdentity.v0.2.json) · [Belief Envelope v0.1](../schemas/BeliefEnvelope.v0.1.json)
→ [Memory Bridge Protocol](https://github.com/Alex-Mtz-Dev/memory-bridge-protocol)
