# Biome rule selection: what is on, what is off, and why

> **Build documentation, not user documentation.** This records which Biome lint
> rules this repo enables and, for every rule it does not, a one-line reason.
> Nothing here affects how the MCP server behaves for a client. User-facing docs
> live one level up in [`docs/`](../).

| | |
| --- | --- |
| **Status** | Applied |
| **Measured on** | Biome 2.5.5, against this branch merged with `main` |
| **Companion** | [`lint-tooling.md`](lint-tooling.md) (where lint runs), [`biome-on-android.md`](biome-on-android.md) (how it runs) |

`biome.json` rejects comments, so the rationale that cannot live next to the
config lives here.

## The selection rule

**Zero-violation ratchet.** A rule is enabled only once `src/`, `tests/` and
`scripts/` are already clean for it, so `pnpm check` stays green in the same
commit that turns it on. Cleanup lands first, the rule after — never a rule plus
a bulk rewrite in one change.

Everything below was measured the same way: each candidate enabled *alone*
against `src/ tests/ scripts/`, diagnostics counted. Counts in this document are
that measurement, not an estimate.

## What is on

Of the 432 JS/TS rules Biome 2.5.5 ships, **265 are active**: `recommended`
plus 85 listed explicitly in `biome.json`, plus the `test` domain, which Biome
auto-enables because vitest is a dependency (`noFocusedTests`,
`noDuplicateTestHooks`).

Two overrides narrow that set, both directory-level policy rather than an escape
hatch for a specific offender:

| Path | Rule off | Why |
| --- | --- | --- |
| `tests/**`, `scripts/**` | `noExcessiveCognitiveComplexity` | Cognitive complexity counts nested callbacks, so a `describe`/`it` tree trips it structurally. |
| `tests/**`, `scripts/**` | `useTopLevelRegex` | A regex recompiled in a test or a one-shot probe script has no hot path to slow down. |
| `**/*.config.ts` | `noDefaultExport` | `vitest.config.ts` and `tsdown.config.ts` legitimately default-export. |

Don't widen either of the first two to `src/`.

## Off by policy

### The whole `nursery` group

Nursery rules change semantics between Biome minors, and Renovate bumps Biome
automatically — one would break CI with no human in the loop. This is a blanket
decision: nursery rules are not evaluated individually for adoption, only for
the day they are promoted.

### The `types` domain, beyond the two rules already paid for

`useArrayFind` and `useArraySortCompare` are the only `types`-domain rules
enabled. They are why the `PostToolUse` hook runs with `--skip=types` — they
force a project-wide type-inference pass on every invocation
([`lint-tooling.md`](lint-tooling.md)). Adding a third rule to the domain buys
inference that is not trustworthy yet: `noFloatingPromises` reports nothing on
its *own documented examples* in this repo, and `noUnnecessaryConditions`
false-positives on optional chaining (`response.meta?.has_more ?? …` in
`src/utils/pagination.ts`, where `meta` is optional so the `??` is required).

**Zero diagnostics from a `types` rule means "not analysed", not "clean".**
`pnpm typecheck` is the real type gate.

## Off — not applicable to this codebase

68 rules target frameworks and runtimes this project does not use: React,
React Native, Solid, Next.js, Vue, Qwik, Svelte, Playwright and Drizzle. They
are listed here as one line because none can ever fire: there is no JSX, no DOM
and no ORM in this repo.

A further group is inert for the same reason, one line each:

| Rule | Why off |
| --- | --- |
| `noNoninteractiveElementInteractions` | a11y rule; no JSX or DOM. |
| `noImplicitBoolean`, `noJsxLiterals`, `useFragmentSyntax`, `useSelfClosingElements`, `useConsistentCurlyBraces` | JSX-only. |
| `noInlineStyles`, `useDomQuerySelector`, `useIframeSandbox`, `useSortedClasses`, `noUndeclaredClasses` | Browser/DOM-only. |
| `noAlert` | Browser-only (`alert`/`confirm`/`prompt`). |
| `noExcessiveNestedTestSuites` | Test domain, but gated on jest; this repo uses vitest. |
| `useStrictMode` | The package is ESM, which is always strict. |
| `noRestrictedGlobals`, `noRestrictedImports`, `noRestrictedTypes`, `noRestrictedElements`, `noRestrictedDependencies`, `noUndeclaredEnvVars` | Inert without a configured deny-list; enabling them unconfigured is a no-op. |

## Off — evaluated and rejected

Rules the tree is already clean for, or nearly so, that were deliberately not
enabled. One line each; the count is diagnostics across `src/ tests/ scripts/`.

| Rule | Hits | Why off |
| --- | ---: | --- |
| `useNamingConvention` | 992 | Zendesk API fields are snake_case; renaming them would fight the wire format. |
| `noMagicNumbers` | 318 | Mostly test fixtures and HTTP status codes that are clearer inline. |
| `useBlockStatements` | 178 | The codebase uses single-line guard clauses deliberately. |
| `useImportExtensions` | 176 | Imports are extensionless by design (bundler resolution). |
| `noProcessGlobal` | 154 | It is a Node CLI; `process` is the platform, not a leak. |
| `noTernary` | 159 | Ternaries are idiomatic here; `noNestedTernary` is enabled instead. |
| `noConsole` | 88 | 79 of 88 are in `scripts/`, whose output *is* console; the 4 in `src/` are deliberate and commented (logger sink, fatal handler, the OAuth URL that must bypass the level-gated logger). |
| `noProcessEnv` | 76 | `config.ts` reads env by design; that is its job. |
| `useNumericSeparators` | 52 | Mostly 3–4 digit test fixtures where separators add noise. |
| `noExcessiveLinesPerFunction` | 49 | The big hits are `ToolDefinition[]` factories — line count measures how many tools exist, not complexity. Contradicts the documented architecture. |
| `noNodejsModules` | 46 | It is a Node application. |
| `noUnresolvedImports` | 31 | All false positives: Biome cannot read the export maps of `msw` and `@modelcontextprotocol/sdk`. Was 110 on 2.5.4; worth re-checking on future bumps. |
| `noExcessiveLinesPerFile` | 18 | Same as `noExcessiveLinesPerFunction`: a namespace of tools is legitimately long. |
| `useExportsLast` | 17 | Pure ordering preference; the repo interleaves exports with the code they belong to. |
| `noUselessUndefined` | 14 | `return undefined` is *clearer* in a function typed `T \| undefined`. |
| `useDestructuring` | 14 | Stylistic; the explicit form reads better at several sites. |
| `noDelete` | 13 | All in tests unsetting env vars. The alternative assigns the *string* `"undefined"` — a real footgun. |
| `noContinue` | 12 | Guard-style `continue` keeps the loop bodies flat. |
| `noSecrets` | 13 | All false positives on PKCE strings and URLs. |
| `useConsistentMethodSignatures` | 14 | Property-vs-method syntax preference with no practical consequence here. |
| `noAwaitInLoops` | 12 | The pagination loops are sequential *by necessity* — each cursor depends on the previous response. |
| `noUnusedTemplateLiteral` | 11 | Cosmetic. |
| `useExplicitLengthCheck` | 12 | Its autofix rewrites `x?.length &&` to `x?.length > 0 &&`, which does not type-check, and the manual form loses the narrowing the truthiness check provides. 11 type errors for a cosmetic gain. |
| `noEqualsToNull` | 9 | `!= null` is the intended nullish check, not an accident. |
| `noIncrementDecrement` | 9 | `i++` in a counted loop is clearer than `i += 1`. |
| `noNamespaceImport` | 9 | `import * as z from 'zod/v4'` is the documented zod idiom. |
| `useAwait` | 9 | `async` without `await` is imposed by the MCP SDK's handler interface. |
| `noEmptyBlockStatements` | 7 | Intentional no-op catches and stub callbacks. |
| `useSimplifiedLogicExpression` | 6 | Its De Morgan rewrites are not simpler to read. |
| `useMaxParams` | 5 | A 4-parameter threshold is arbitrary; the 5 sites use defaults or are low-level helpers where positional args are idiomatic. |
| `noNegationElse` | 4 | Reads fine as written. |
| `noParameterProperties`, `useConsistentMemberAccessibility` | 3 each | Class-oriented; the codebase has one class (`ZendeskApiError`). |
| `noVoid` | 3 | `void promise` is deliberate fire-and-forget. |
| `noForEach` | 2 | Two sites where `forEach` reads better than `for…of`. |
| `noNestedPromises` | 2 | The OAuth flow's inner `.then` is detached *on purpose* — `beginAuth` returns the URL immediately and the token lands later. Worth revisiting deliberately, not as a lint sweep. |
| `useForOf` | 1 | One indexed loop that reads fine. |

## Off — nursery rules the tree is nonetheless clean for

Listed so the next Biome bump can pick them up cheaply: when one of these is
promoted out of nursery, it can be enabled with no code change.

`noExcessiveNestedCallbacks`, `noLoopFunc`, `noNegationInEqualityCheck`,
`noUnnecessaryTemplateExpression`, `useArraySome`, `useImportsFirst`,
`useReduceTypeParameter`, `useRegexpTest`, `useThisInClassMethods`,
`useVarsOnTop` — all at zero.

`noBaseToString` (1) is the one nursery rule with a live hit; it is also a
`types` rule, so it is closed by both policies.

`noIdenticalTestTitle`, `useConsistentTestIt`, `useTestHooksInOrder`,
`useTestHooksOnTop`, `noConditionalExpect`, `useExpect` — test-quality rules,
verified working, blocked only by the nursery policy. `useExpect` (3) and
`noConditionalExpect` (0 after the rejection tests were fixed) are the two worth
taking first.

`useExplicitReturnType` (99) and `useExplicitType` (112) would need a sweep
across the codebase before they could go on. `useUnicodeRegex` (92) is a no-op
here — every regex is an ASCII character class — so it is volume without value.
`useNamedCaptureGroup` (4), `useRegexpExec` (1), `noUselessTypeConversion` (2),
`noMisleadingReturnType` (1) are small but sit behind the same policy.
