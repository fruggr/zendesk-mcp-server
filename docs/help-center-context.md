# Help Center context: instructions & MCP resources

Beyond tools, the [Zendesk MCP Server](../README.md) hands an LLM the structural
context it needs to work against *your* Help Center, so it stops guessing locales
or fuzzy-matching section names and uses real IDs instead. This document covers
what is exposed, what it costs, and how to turn each piece off.

Everything here is active only when the `help_center` namespace is (the SLA
alert resources, when `list_sla_alerts` is exposed), and every fetch uses **the caller's own
OAuth token**, so the context respects that user's
read permissions exactly like the tools do.

Clients that don't consume `instructions` or `resources` simply ignore them: the
whole feature degrades silently, it never breaks a session.

## `instructions` (sent on `initialize`)

A short, static blob auto-loaded by compliant clients. It names the Zendesk
subdomain (and the brand scope, when `--brand-ids` restricts the server) and
points at the topology resource. No Zendesk request is made to build it.

When `list_sla_alerts` is exposed (the `tickets` namespace, and `--tool` if
set) it ends with one SLA line of its own: that `list_sla_alerts` and the
`zendesk-sla://alerts/...` resources exist, the default thresholds in force,
and how a user changes theirs: `configure_sla_alerts` only where it is exposed
too, otherwise the thresholds apply to everyone. That line stays under
`--no-topology` and without `--sla-push` (it just does not mention subscriptions
there); with neither Help Center context nor SLA alerts, there are no
instructions at all.

## `zendesk-sla://alerts/...` (SLA alert resources)

Active wherever `list_sla_alerts` is exposed; read with the caller's token and
their alert thresholds (personal ones only where `configure_sla_alerts` is
exposed), and rendered exactly like `list_sla_alerts` with its
defaults. Three templates:

| URI | Alert set |
|---|---|
| `zendesk-sla://alerts/{mine,my_groups,all}` | the caller's, their groups', or every unsolved ticket (listed in `resources/list`) |
| `zendesk-sla://alerts/views/{view}` | a view, by title or id |
| `zendesk-sla://alerts{?query}` | any Zendesk ticket search |

With `--sla-push` (`SLA_PUSH=true`), the server advertises `resources.subscribe`: a
URI subscribed to (2025 revisions) or listened to (`subscriptions/listen`,
2026-07-28) is re-checked every `SLA_POLL_SECONDS` and the client gets
`notifications/resources/updated` only when its alert set changes; the
resource descriptions invite a subscription only then. Polling never opens a
browser sign-in: on stdio, with no token left to refresh, it waits for the next
tool call to sign in. A Zendesk 401 on a read or a poll drops the token like a
tool's would. On HTTP, a session or grant with no request for 30 minutes is
dropped with its subscriptions: the client reconnects and subscribes again.
Polling, quota and where the per-user cache lives are covered under
[SLA alerts](configuration.md#sla-alerts); this resource's scheme is fixed,
unlike the Help Center one below.

## `zendesk-hc://topology` (pull-only resource)

A [pull-only MCP resource](https://modelcontextprotocol.io/docs/concepts/resources):
read on demand, never pushed. It returns Markdown describing

- the active locales, and which one is the default;
- the category → section tree, with IDs;
- the visibility user segments;
- the Guide permission groups;
- the calling user's role.

When the server is restricted with `--brand-ids`, the locales and the
category/section tree are read from the FIRST allowed brand (named in the
header, which also lists the allowed brands); with `--brand-ids all` or the
flag unset they are the account default brand's. User segments, permission
groups and the calling user are account-wide either way — user segments are
shared across brands, not per-brand.

Prefer these IDs (`section_id`, `permission_group_id`, `user_segment_id`,
`locale`) over guessing from names.

Partial results are explicit. Listing permission groups and user segments
requires **Guide-admin / Help Center manager** rights. With a content-editor
token those two sections are marked *unavailable* rather than empty, and the
rest still renders; reuse those IDs from an existing article (`get_article`)
instead.

Large Help Centers stay concise. Past a size threshold the section tree is
summarized per category, with a pointer to the `list_sections` tool for the
detail.

## `zendesk-hc://article/{id}` (pull-only resources)

Two distinct capabilities behind one URI template. With `--brand-ids` naming
several brands or `all`, the template gains a brand dimension —
`<scheme>://brands/{brand}/articles/{id}` — because an article id alone does
not say which brand's Help Center holds it. The brand is named by id or
subdomain, exactly like the tools' `brand_id`, and is resolved through the
same allow-list: a read for a brand outside the allow-list fails like a tool
call would. Unset and single-brand servers keep `<scheme>://article/{id}`.

Read-by-id: any article id can be read on demand and comes back as Markdown.
That is one Zendesk fetch, with no preloading, and it consumes no LLM context
until an article is actually opened.

Promoted pre-listing: the resource's *listing* surfaces the promoted
(*featured*) articles, so a user can pin one in clients that support resource
pinning or `@`-mentions. The companion `list_promoted_articles` tool returns the
same set. In multi/all mode the listing runs the bounded scan once per allowed
brand and each entry carries its brand-scoped URI.

### What the pre-listing costs

Only the pre-listing costs requests. Zendesk has no server-side filter for
promoted articles, so finding them means scanning article pages, one API request
per page and per brand in scope, capped by
[`ARTICLE_RESOURCES_SCAN_MAX_PAGES`](configuration.md#article_resources_scan_max_pages).

- The scan runs only on a client's `resources/list` call or a
  `list_promoted_articles` call, **never at connect time**. No other tool
  triggers it.
- The resource listing is cached for 5 minutes, so repeated `resources/list`
  calls coalesce. The cache belongs to one user: per connection on stdio, per
  session for a 2025 HTTP client, per grant for a 2026-07-28 HTTP client (each
  of its requests gets a fresh server, the cache stays). The topology resource
  and the brand list (multi-brand servers) are cached the same way.
- The `list_promoted_articles` tool performs a fresh scan on every call.

## Turning it off

| Flag | Effect |
|------|--------|
| [`--no-topology`](configuration.md#cli-reference) | Disables the `instructions` blob **and** the topology resource. They toggle together. |
| [`--no-promoted-articles`](configuration.md#cli-reference) | Disables the promoted pre-listing (the resource `list` scan), so the server makes zero preloading requests. **Reading a known article by id and the `list_promoted_articles` tool stay available**: both run only when explicitly asked for. |

## Branding the URI scheme

`zendesk-hc://` is the default. A deployer can rebrand it with
[`--hc-resource-scheme` / `HC_RESOURCE_SCHEME`](configuration.md#hc_resource_scheme):
`wiki`, for instance, yields `wiki://topology` and `wiki://article/{id}`. It
takes a bare RFC 3986 scheme, without `://`.

## Troubleshooting

`Permission denied` on `list_permission_groups`, `list_user_segments` or the
topology resource is covered in
[troubleshooting.md](troubleshooting.md#permission-denied-on-list_permission_groups-list_user_segments-or-the-topology-resource).

---

← Back to the [README](../README.md).
