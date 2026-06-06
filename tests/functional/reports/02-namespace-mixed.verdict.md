# Verdict — 02-namespace-mixed

| ID  | Status | Notes                                                                          |
| --- | ------ | ------------------------------------------------------------------------------ |
| A1  | OK     | `.tools.length === 3`, names {zendesk_tickets, zendesk_help_center, zendesk_users}. |
| A2  | OK     | `zendesk_tickets`: `readOnlyHint=false`, `destructiveHint=true` (aggregates writes). |
| A3  | OK     | `zendesk_help_center`: `readOnlyHint=false`, `destructiveHint=true`.           |
| A4  | OK     | `zendesk_users`: `readOnlyHint=true`, `destructiveHint=false` — load-bearing `every`/`some` aggregation confirmed. |
| A5  | OK     | `openWorldHint === true` on all 3.                                             |
| A6  | OK     | No description carries the `[RO] ` prefix (0 of 3).                             |

## Summary

🟢 All 6 assertions pass. `--mode namespace` (no `--read-only`) aggregates
annotations per namespace correctly: write-bearing namespaces are destructive,
the all-read `zendesk_users` namespace stays read-only, and no `[RO] ` prefix
leaks outside read-only mode.

## Proposed actions

None — scenario closed `OK`.
