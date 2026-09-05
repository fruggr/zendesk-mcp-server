# ⚠️ LEADING LLM ONLY — DO NOT READ IF YOU ARE THE EXECUTOR

Reading this file biases the report. Stop now and read only `spec.md`.

---

## Expected values (verdict criteria)

- **A1 — opt-in, negative.** No entry named `zendesk_requests` in the default
  listing. This is the load-bearing assertion of the scenario: `requests` is
  excluded from `DEFAULT_NAMESPACES` in `src/config.ts`, so an operator who does
  not ask for it must not receive it.
- **A2 — no collateral drift.** The default listing still holds the same three
  proxies as scenario 02 (`zendesk_tickets`, `zendesk_help_center`,
  `zendesk_users`). A count of 4 means the opt-in gate leaked.
- **A3 — opt-in, positive.** `tools.length === 1`, name `zendesk_requests`.
  `--namespace` REPLACES the default set rather than adding to it, so the
  agent proxies must be gone here.
- **A4 — operation count.** Exactly 7 `- **<name>**:` lines in the proxy
  description (`buildOperationList` emits one per operation).
- **A5 — operation names.** Set equality; order follows the factory and is not
  asserted.
- **A6 — write markers.** Exactly 3 carry the ` (write)` suffix:
  `create_request`, `add_request_comment`, `mark_request_solved`. The four reads
  must not.
- **A7 — strict schemas.** `additionalProperties: false` on all 7, including
  `list_request_forms`, whose schema is `z.object({})` and must still serialize
  as `{type:"object", properties:{}, additionalProperties:false}` (#100).
- **A8 — parameter descriptions.** Every property under
  `inputSchema.properties` has a non-empty `description`. This is the Glama
  Parameter Semantics dimension, and the deterministic floor
  (`tests/unit/tools/tool-quality.test.ts`) already gates it — a failure here
  means the wire serialization dropped what the Zod schema carried.
- **A9 — audience disambiguation.** Each first sentence must scope the tool to
  the signed-in user's own requests. Only the first sentence is surfaced by a
  namespace proxy (`summarizeDescription`), and these tools can be exposed
  alongside `list_tickets` / `create_ticket` / `add_public_comment`, so an
  ambiguous opener is a real defect, not a style note.
- **A10 — the phantom-solve disclosure.** Must say the operation is refused
  unless the requester may actually solve the request. Zendesk answers 200 and
  changes nothing otherwise, so a model that does not know this will report a
  success that never happened.
- **A11 — the reopen disclosure.** Must say a reply on a solved request reopens
  it. Measured behaviour; a user should not reopen their ticket unknowingly.
- **A12 — the diagnostic flag.** Output names `zendesk_requests` and its 7
  operations. Crucially it must NOT open a browser or block on OAuth: tool
  definitions are pure and `--print-tools` short-circuits before the token
  store is built. A browser window opening here is a failure.

## Failure diagnostics

| If FAIL on | Likely cause | Where to look |
| ---------- | ------------ | ------------- |
| A1, A2 | `requests` leaked into the default set, or the default is applied in `loadConfig` instead of the schema (so `ConfigSchema.parse` callers miss it) | `src/config.ts` `DEFAULT_NAMESPACES` and the `namespaces` field |
| A3 | `--namespace` treated as additive, or `NAMESPACE_LABELS` missing the `requests` entry (which would silently register no proxy) | `src/routing/registry.ts`, `src/server.ts` `case 'namespace'` |
| A4, A5 | A tool missing from `createRequestTools`, or filtered out unexpectedly | `src/tools/requests.ts`, `src/tools/index.ts` |
| A6 | `readOnly` flag wrong on a definition; check it matches `annotations.readOnlyHint` | `src/tools/requests.ts` |
| A7 | Strict-schema registration regressed | `src/server.ts` (`inputSchema.strict()`) |
| A8, A9, A10, A11 | Description or `.describe()` text weakened | `src/tools/requests.ts` |
| A12 | `--print-tools` wired after the token store, or rendering diverged from `registerToolset` | `src/index.ts`, `src/routing/print.ts` |
