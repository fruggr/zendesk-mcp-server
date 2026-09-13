# Mission: probe the Zendesk end-user API surface (issue #48)

**For:** an agent running with authenticated access to a real Zendesk instance.
**Why:** issue #48 ("End-user mode") is being planned. Several facts cannot be
settled from the public documentation, and guessing them would put the wrong
tool surface in the plan. This mission establishes them empirically.

**Deliverable:** a report posted as a comment on the pull request for
`claude/issue-48-analysis-czaqzt` (or, if that PR is gone, on issue #48).
Answer every question below by its identifier (B1…B11), each with:

- the exact request made (method, path, query string, body shape — redact values),
- the HTTP status,
- the relevant part of the response (redact personal data: names, emails,
  subjects, ticket bodies — the *shape* is what matters, not the content),
- a one-line verdict: **confirmed / refuted / inconclusive**.

Mark a question **inconclusive** rather than inferring. An inconclusive answer
is a useful result; a plausible-sounding guess is not.

## Ground rules

- **Do not modify this repository.** No commits, no branch pushes. Your output
  is the report comment only.
- **Read-only wherever possible.** Where a write is unavoidable (B6, B8, B9,
  B10) use an obviously disposable test request — subject prefixed
  `[MCP probe #48]` — and note its request id in the report so it can be
  cleaned up. Do not touch any pre-existing ticket.
- Prefer a **sandbox** instance. If only production is available, restrict
  yourself to the read-only questions and mark the write ones
  *not attempted (production)*.
- Raw HTTP (curl or equivalent) against `https://<subdomain>.zendesk.com` is
  the right tool here — this probes the Zendesk API, not this MCP server.

## Accounts needed

Two tokens, if you can get them:

- **EU** — a token for a user whose `role` is `end-user`.
- **AG** — a token for an agent or admin.

Most questions need EU. If you cannot obtain an end-user token at all, that
outcome *is* the answer to B1, and it is the single most important result of
this mission — report it and continue with AG where the question still makes
sense (noted per question).

## Questions

### B1 — Can an end user complete the OAuth flow? (blocking)

No Zendesk documentation states whether the authorization-code flow is
available to a user whose role is `end-user`; the endpoints and the
`requests:read` / `requests:write` scopes suggest yes, but nothing confirms it.

1. Sign in as an end user and open
   `https://<subdomain>.zendesk.com/oauth/authorizations/new?response_type=code&client_id=<id>&redirect_uri=<uri>&scope=read+write&code_challenge=<c>&code_challenge_method=S256`
2. Does the consent screen render, or does Zendesk reject/redirect (to a sign-in
   page, an agent-only interstitial, an error)? Report exactly what appears.
3. If it renders: complete it and exchange the code at `/oauth/tokens`. Report
   whether an access token comes back and whether a refresh token comes with it.
4. Repeat step 1 with `scope=requests:read+requests:write` and report any
   difference (consent screen wording, acceptance, rejection).

Report the OAuth client's configuration that made this work (redirect URL,
scopes registered) — the end-user onboarding guide in #48 has to document it.

### B2 — Exact role string

`GET /api/v2/users/me` with EU. Report the literal value of `role` (is it
`end-user`, `end_user`, something else?) and whether `role_type` is present.
Then the same with AG, for comparison. This drives the role-mismatch check.

### B3 — Ticket forms readable by an end user

With EU: `GET /api/v2/ticket_forms?active=true&end_user_visible=true&fallback_to_default=true`

- Status? If 403, that alone reshapes the plan — say so plainly.
- How many forms come back, and does each carry `id`, `name`, `display_name`,
  `ticket_field_ids`, `end_user_visible`, `end_user_conditions`, `position`,
  `default`?
- Is `display_name` populated, or empty/absent (falling back to `name`)?
- Repeat **without** `fallback_to_default`: on this instance, does the
  parameter change the result? (It is the proposed graceful-degradation path
  for single-form plans.)
- What does this instance's plan actually allow — one form or several?

### B4 — Ticket fields readable by an end user

With EU: `GET /api/v2/ticket_fields`

- Status?
- Are `visible_in_portal`, `required_in_portal`, `editable_in_portal` and
  `title_in_portal` present on the returned objects? List which are missing.
- Does the response include fields that are **not** portal-visible (i.e. must
  we filter client-side), or does Zendesk already filter for an end user?
- Do `custom_field_options` come back with `name` / `value` / `raw_name`?
- Is the endpoint paginated here, and with which shape (`page`/`per_page`
  offset, or `page[size]` cursor)?

### B5 — Listing and reading own requests

With EU:

- `GET /api/v2/requests` — status; pagination shape (offset `page`/`per_page`,
  or cursor `page[size]`/`links.next`); which attributes are populated.
- `GET /api/v2/requests?sort_by=updated_at&sort_order=desc` — honoured?
- `GET /api/v2/requests?status=open,pending` — does the `status` filter work on
  **List** Requests, or only on Search Requests? (The documentation lists it
  under Search; confirm or refute for List.)
- `GET /api/v2/requests/{id}` — is `can_be_solved_by_me` present, and what is
  its value on a request that is unassigned vs assigned to an agent?
- `GET /api/v2/requests/{id}/comments` — do comments carry `attachments` with
  `content_url`, and are `author_id` / `created_at` present? Are agent replies
  and the requester's own comments distinguishable?
- `GET /api/v2/requests/search?query=<word>` — status, and does it search only
  the caller's own requests?

### B6 — Submitting a request, and what the API validates

With EU. Subject prefixed `[MCP probe #48]`.

1. `POST /api/v2/requests` with a minimal body (`subject` + `comment.body`) and
   **no** `ticket_form_id`. Status? Which form does the created request land on?
2. Same, **with** `ticket_form_id` set to a form from B3. Does the response echo
   `ticket_form_id`?
3. **The key question:** pick a form having a field with
   `required_in_portal: true`, and POST **omitting** that field. Does Zendesk
   return 422, or does it accept the request? Quote the 422 body verbatim if
   there is one — its shape decides whether we can surface a usable message.
4. Same with a field that is required only through `end_user_conditions`
   (conditionally required). Does the API enforce the condition, or is it
   enforced only by the web widget? If this instance has no conditional form,
   say so and mark inconclusive.
5. Does `POST /requests` accept `custom_fields` as `[{ id, value }]`? Report
   whether `fields` is also accepted as an alias.
6. Are `priority` / `type` actually settable by an end user, or silently ignored?

### B7 — What an end user may read on their own request

With EU, on a request that has at least one agent internal note (ask an agent to
add one, or use an existing test request):

- Does `GET /requests/{id}/comments` hide the internal note? Confirm that
  nothing agent-private leaks through this path.
- Does `GET /api/v2/tickets/{id}` (the **agent** path, for the same ticket)
  return 403/404 for EU? This is what justifies not exposing the agent ticket
  tools to end users.
- Does `GET /api/v2/search?query=...` return 403 for EU?

### B8 — Commenting on own request

With EU: `PUT /api/v2/requests/{id}` with `{ "request": { "comment": { "body": "..." } } }`

- Status, and is the comment public (end users cannot post private ones)?
- On a **closed** request, what happens? Quote the error.

### B9 — Marking a request solved

With EU:

- On a request where `can_be_solved_by_me` is **true**:
  `PUT /requests/{id}` with `{ "request": { "solved": true } }` — status, and
  resulting `status` value.
- On one where it is **false**: what error comes back? Quote it. (We want to
  pre-empt this client-side with a clear message rather than surface a raw error.)
- Can `solved` and `comment` be sent in the **same** PUT?

### B10 — Attachments

With EU:

1. `POST /api/v2/uploads.json?filename=probe.txt` with a small text body and
   `Content-Type: application/octet-stream`. Status? Is `upload.token` returned?
2. Chain a second file by passing `token=<first token>`. Does the token
   aggregate both files, as the documentation says?
3. Use that token in `POST /requests` as `comment.uploads: [token]`. Is the file
   attached to the created request?
4. Same via `PUT /requests/{id}` on a follow-up comment.
5. Is there an enforced size limit, and what error does exceeding it produce?

### B11 — Agents on the end-user path

The documentation says "admins and agents are treated as end users when using
the Requests endpoint". With AG:

- `GET /api/v2/requests` — does it return the agent's *own* requests (those
  where they are the requester), and does it return 200?
- `POST /api/v2/requests` — accepted for an agent?

This decides whether the end-user toolset is usable by an agent too (which
would make a role-mismatch warning informational rather than an error).

## Report template

```
## Mission report — issue #48 end-user API probe

Instance: <sandbox | production>, plan: <plan name if known>
Tokens used: EU = <obtained | not obtained>, AG = <obtained | not obtained>

### B1 — OAuth for an end user: CONFIRMED | REFUTED | INCONCLUSIVE
<request / status / response shape / verdict>

… one block per question, B1 through B11 …

### Surprises
Anything encountered that none of the questions asked about but that
would change the design.

### Cleanup
Request ids created by this probe: #…
```

Do not skip the **Surprises** section — an undocumented behaviour found in
passing is often worth more than a confirmed expectation.
