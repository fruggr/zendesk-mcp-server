# ⚠️ LEADING LLM ONLY — DO NOT READ IF YOU ARE THE EXECUTOR

Reading this file biases the report. Stop now and read only `spec.md`.

---

## Expected values (verdict criteria)

- **P1 — under the cap.** Every proxy description is ≤ 2048. At the time of
  writing: `help_center` 877, `single` 1 266. Claude Code cuts
  longer descriptions (`docs/decisions/proxy-schema-surface.md`).
- **P2 — names kept in the description.** The last line starts with
  `Operations: ` and lists comma-separated names. If it is missing, the builder
  fell back because the surface outgrew the cap. The unit test should have
  caught that first.
- **P3 — line shape.** After the one-sentence header, each line matches
  `- <name>(<params>): <first sentence>`, with an optional ` (write)` suffix.
  Required params end with `*`.
- **P4 — the #329 cases.** `create_article(...)` contains `label_names`
  (optional, no `*`). `get_article_section(...)` contains `section_index*`.
  `update_article_section(...)` contains `content*` and `format`.
- **P5 — single mode is complete.** The line count equals the sum over the
  namespace proxies of the default listing (the `requests` namespace is opt-in
  and absent from both).
- **P6 — perception.** The model's list matches the operation set with none
  missing (before the fix, the second half of `help_center` was cut). The
  parameter names are exact, with no `labels`, `index` or `body` guesses.
- **P7 — probe.** `OK: a 15000-char property description reached the model whole.`
  A FAIL means the client now cuts schema descriptions: the fix no longer holds
  for that client and needs a decision.
