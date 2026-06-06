# Contributing to Memory Bridge Protocol

This is an early, public proposal for a trust-and-governance layer for multi-agent systems. At this stage the most valuable contributions are **conceptual pressure-testing**, not code.

## What's most useful right now

1. **Tell us where the schema breaks.** If you build agents and the `AgentIdentity` schema doesn't fit your architecture, open an issue describing the mismatch. A field that's missing, a `trust_class` that doesn't map, a constraint that's wrong — these are the highest-signal contributions.

2. **Adopt the schema and report back.** If you use [`AgentIdentity.v0.1`](schemas/AgentIdentity.v0.1.json) in a real project, say so in a "Show & tell" issue. Early adoption signal is what tells us whether the framing is right.

3. **Challenge the trust model.** The confidence-ceiling and quorum-weight design is opinionated. If you think the precedence order is wrong, or that confidence ceilings are the wrong mechanism, argue it.

## How to propose a schema change

1. Open an issue describing the problem the change solves — the *why* before the *what*.
2. If there's rough agreement, open a PR against the relevant schema file.
3. Schema changes are versioned. A breaking change increments the schema minor version (`v0.1` → `v0.2`); examples and docs must be updated in the same PR.

## Scope boundaries

The following are **out of scope** for this repository and will not be accepted:

- The proprietary orchestration engine and belief-lifecycle services
- Any hosted/multi-tenant control-plane code
- Vendor-specific runtime implementations (those belong in their own repos)

This repo holds the **open specification and schemas** only.

## Ground rules

- Be specific. "This doesn't work" is not actionable; "the `confidence_ceiling` clamp breaks my use case because X" is.
- Assume good faith and argue the idea, not the person.
- Keep PRs small and single-purpose.

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
