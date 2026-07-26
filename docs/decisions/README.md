# Decision records

**Build documentation, not user documentation.** One file per technical decision
that was expensive to reach and would otherwise be re-litigated or silently
reverted: what was chosen, what was measured, what was rejected and why.

Aimed at maintainers and AI agents working on the repo. User-facing
documentation lives one level up in [`docs/`](../).

A record belongs here when the reasoning is not recoverable from the diff — a
non-obvious configuration flag, a dependency deliberately *not* adopted, a
trade-off with numbers behind it. Each one states the PR that applied it.

| Record | Decision |
| --- | --- |
| [`lint-tooling.md`](lint-tooling.md) | Stay on Biome rather than adopt Oxc; run `--skip=types` on the per-edit hook and enforce the type-aware rules at pre-commit. |
