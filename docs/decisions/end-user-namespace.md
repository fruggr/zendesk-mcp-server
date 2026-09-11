# The end-user surface is an opt-in namespace, not a profile

**Status**: accepted (issue #48, PR #264)

## Context

The server was built for Zendesk agents. Its per-user OAuth means it can equally
serve **end users** — the customers who, on the web, open a ticket through the
Help Center's "Submit a request" form. Issue #48 made that a first-class
audience.

An end user cannot use the agent ticket tools: `/api/v2/tickets` answers 403 for
them, because `/api/v2/requests` is the path Zendesk reserves for requesters.
So the end-user journey needs its own tools, and the question was how an
operator selects them.

The issue proposed a **profile** chosen at startup — `--profile end-user` —
which would replace the agent ticket surface with the end-user one.

## Decision

No new configuration axis. The tools land in a **`requests` namespace**, absent
from `DEFAULT_NAMESPACES`, selected with the existing `--namespace requests`.
"End-user mode" survives as an *audience* in the README, not as a flag.

Alongside it, a `--print-tools` flag prints the surface a given set of flags
resolves to and exits.

## Why not a profile

**It would have been a third axis over the same thing.** `--namespace` and
`--tool` already pick the inventory, `--mode` packages it, `--read-only`
narrows it. A profile picks the inventory too, so it overlaps `--namespace`
rather than composing with it — and the immediate question, put by the
maintainer, was what `--profile end-user --namespace tickets --mode all` is
supposed to mean. Additive? Forbidden? Whichever answer you pick, you have
added a rule an operator must learn, to express something `--namespace` already
expressed.

**The ecosystem calls this a toolset, and puts it on one axis.** The [GitHub MCP
server](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/configure-toolsets)
groups tools into `toolsets`, with `default` and `all` keywords *inside* that
axis rather than beside it. There is no "profile" convention in MCP to align
with. Our `--namespace` is the same axis; adding to it was the conventional
move.

**The real question the profile was answering was legibility**, not capability:
"what do I get if I combine these flags?" That is better answered by the server
than by a flag whose interaction rules you then have to document —
hence `--print-tools`, which answers it for every axis at once, needs no
credential, and makes no network call.

The cost is discoverability: "run it for your customers" is now
`--namespace requests --namespace help_center`, which reads as plumbing rather
than as choosing an audience. The README's End-user mode section carries that
weight instead.

## Why opt-in rather than on by default

Adding `requests` to the enum without touching the default set would have been
less code. It was rejected on evidence, not taste.

A probe of the live API found that under an **agent** token, part of the
Requests surface silently misbehaves rather than failing:

- `PUT /requests/{id}` with `solved: true` returns **200 and changes nothing**.
- A form's `required_in_portal` validation is **not applied** to agents: a
  submission missing a portal-required field returns 201 with an empty subject.
- `priority` and `type` are **stored** for an agent and **dropped** for an end
  user.

So shipping these tools to every agent install would ship an operation that
reports success on a no-op. Secondarily, an agent install keeps its tool list
and context budget unchanged.

Note what this does **not** buy: Glama scores the flat surface, so the seven
end-user tools are evaluated like any other, and the server score's `40% min`
term means one thin definition drags everything down whether or not it sits
behind a flag. Opt-in is a correctness decision, not a quality exemption.

## Consequences

- **The default namespace set is now explicit**, and no longer "every member of
  the enum". That asymmetry is the one non-obvious rule this decision
  introduces, and it is stated in `docs/configuration.md`.
- **The default lives in `ConfigSchema`, not in `loadConfig`.** The integration
  harness builds its config through `ConfigSchema.parse` and never calls
  `loadConfig`, so a default applied there would not reach the tests — the
  end-user tools would have been visible to every integration scenario while
  absent in production.
- **`namespaces` rejects an empty array** (`.min(1)`). `filterTools` reads `[]`
  as "no filter at all", so an empty list would have exposed the opt-in
  namespace by accident. `parseArgs` cannot produce `[]`, so refusing it costs
  nothing.
- **`--namespace` replaces the default set** rather than adding to it. That was
  already true; it becomes load-bearing here, because `--namespace requests`
  has to mean *only* the end-user surface for a customer-facing deployment.
- **`NAMESPACE_LABELS` is typed `Record<Namespace, …>`** and moved to
  `routing/registry.ts`. Its consumer skips a namespace whose label is missing,
  so an incomplete map would have silently exposed no proxy for a whole
  namespace with every test still green. It is now a compile error.
- **The existing functional baselines needed no edit.** Scenarios 01, 02, 04
  and 05 assert the default surface, and it did not change — which is itself
  evidence the gate works.

## Revisit if

- **Zendesk ships its own end-user MCP server.** `GET /api/v2/account/settings`
  already returns an undocumented `end_user_mcp` block (per-brand enablement,
  OAuth or JWT auth, a request-update polling delay), disabled at the time of
  writing, next to an `agent_mcp` one. Zendesk's published documentation covers
  only the MCP *client*. If a first-party end-user server arrives with an
  adequate scope, this surface becomes a compatibility layer at best.
- **A third audience appears.** Two namespaces on one axis is comfortable;
  several audiences each wanting a bundle of namespaces would be the point at
  which a preset keyword (à la `--toolsets default,all`) earns its place —
  inside the `--namespace` axis, still not beside it.
