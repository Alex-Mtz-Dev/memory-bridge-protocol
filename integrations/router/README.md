# Trust-Aware Agentic Router

A reference implementation of a router that decides **which agent** handles a
task and **how much to trust** a belief, governed entirely by the Memory Bridge
Protocol schemas. Dependency-free (Python 3.11+ stdlib only).

It is built around one compact policy contract — [`router_policy.schema.json`](router_policy.schema.json)
(min confidence floor, domain-authority requirement, trust precedence) — and
consumes the two protocol schemas:

| Schema | Role here |
|---|---|
| [`AgentIdentity.v0.2`](../../schemas/AgentIdentity.v0.2.json) | who an agent is + its enforced confidence ceiling |
| [`BeliefEnvelope.v0.1`](../../schemas/BeliefEnvelope.v0.1.json) | a single governed belief being admitted |

## Trust properties enforced

1. **Confidence clamping.** A belief's asserted confidence is clamped to the
   confidence ceiling of its source agent's trust class (`claude`/`model` ≤ 0.40,
   `worker` ≤ 0.30, `user`/`system` ≤ 1.0). The ceiling map is kept in sync with
   the `allOf` rules in `AgentIdentity.v0.2.json` and `BASE_CONFIDENCE_CEILING`
   in `conflict-resolution/types.ts`.
2. **Registry is source of truth.** Clamping uses the *registered* trust class,
   not the belief's self-declared `source_trust_class`. A belief claiming to be
   from a `user` while its `source_agent` is registered as `claude` is treated as
   `claude` — self-declared escalation is recorded and ignored.
3. **Closed identity contract.** Identities are validated against the v0.2
   trust contract: unknown top-level fields, over-ceiling declarations, and
   unknown trust classes are rejected at registration.
4. **Float-only confidence.** Integer/boolean confidences are rejected — they are
   the signature of the coercion bug (`Math.round`, `parseInt`, `~~v`) that
   `BeliefEnvelope` prohibits because it silently collapses values to 0.

## Files

| File | What |
|---|---|
| `trust_router.py` | core: registry, `clamp_confidence`, `admit_belief`, `TrustRouter.route` |
| `server.py` | stdlib HTTP API over the core |
| `router_policy.schema.json` | the routing policy contract |
| `test_trust_router.py` | adversarial test suite (16 attacks) |

## Run

```bash
# core + adversarial tests (no dependencies)
python3 test_trust_router.py        # or: pytest test_trust_router.py

# HTTP API
python3 server.py                   # 127.0.0.1:8787  (PORT/HOST overridable)
```

### HTTP endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | — | `{"ok": true}` |
| GET | `/agents` | — | registered identities |
| POST | `/agents` | `AgentIdentity` | `201` stored record, or `400 TrustContractError` |
| POST | `/beliefs` | `BeliefEnvelope` | `200` governed (clamped) belief, or `400` |
| POST | `/route` | `{ "domain": str, "candidates"?: [id] }` | ranked routing decisions |

Example — a `claude` agent trying to assert 0.99 as a `user` is clamped and corrected:

```bash
curl -s -X POST localhost:8787/beliefs -d '{
  "belief_id":"b1","proposition":"x","cell_type":"fact",
  "source_agent":"claude","source_trust_class":"user","confidence":0.99,
  "epistemic_status":"inferred","created_at":"2026-06-26T00:00:00Z"}'
# -> confidence 0.4, source_trust_class "claude", _governance.trust_class_overridden true
```

## Adversarial suite

`test_trust_router.py` encodes attacks, not happy paths, grouped by the property
under attack: **(A)** confidence clamping — overflow, range, integer/boolean
coercion; **(B)** trust-class integrity — self-declared escalation, unknown
source; **(C)** identity contract — field injection, over-privileged record,
unknown class; **(D)** routing authority — domain authority precedence and
trust tie-breaks. Each asserts the router refuses the escalation.
