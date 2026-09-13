# Getting started as a customer

This guide is for **customers** of a company that uses Zendesk — people who
would normally open a support ticket through that company's help site. It lets
you do the same thing from your AI assistant instead: describe the problem in
conversation, attach a screenshot, then follow the ticket without going back to
a web form.

It assumes no programming. You will type a few commands, and you will be told
what each one is for.

If you are a **support agent** looking to work your queue from your assistant,
you want the [README](../README.md) instead — that's the other half of this
server.

---

## What you need first

**1. An account on the company's help site.**

Their help site looks like `https://<company>.zendesk.com/hc` — for example
`https://acme.zendesk.com/hc`. Open it and sign in. If you have ever emailed
their support, you probably already have an account; otherwise sign up, or use
the "Sign in with Google" button if it's offered.

Do this before anything else. If you can't sign in there, nothing below will
work, and that's the company's help site to fix, not this tool.

**2. The company's Zendesk name.**

The `<company>` part of that address. In `https://acme.zendesk.com` it is
`acme`. You'll need it in a moment. It is often, but not always, the company's
own name — read it off the address bar rather than guessing.

**3. Node.js 20 or later**, on your computer.

Check what you have by opening a terminal and typing:

```bash
node --version
```

If that prints something like `v20.11.0` or higher, you're set. If it says the
command isn't found, install it from [nodejs.org](https://nodejs.org) — the
version they offer by default is fine.

**4. One thing to ask the company for.**

The server signs you in using something Zendesk calls an **OAuth client**, and
only the company can create it. Ask their support or IT:

> Could you set up a Zendesk OAuth client for the MCP server, and tell me its
> client identifier? It needs `http://localhost:27439/callback` registered as a
> redirect URL, and it should be a *public* client (no secret).

They may already have one, in which case they'll just send you the identifier.
It looks like a short word, e.g. `acme_zendesk`.

> **Why you have to ask.** This is the one step you cannot do yourself, and it
> is deliberate on Zendesk's side: it's what lets the company decide which
> applications may act on their customers' behalf.

---

## Connecting it to your assistant

You tell your assistant about the server by adding a few lines to its
configuration file. Where that file lives depends on which assistant you use —
the [MCP client wiring](../README.md#mcp-client-wiring) section of the README
lists the paths.

The lines to add:

```json
{
  "mcpServers": {
    "zendesk": {
      "command": "npx",
      "args": [
        "-y",
        "@fruggr/zendesk-mcp-server",
        "acme",
        "--namespace",
        "requests",
        "--namespace",
        "help_center"
      ],
      "env": {
        "ZENDESK_OAUTH_CLIENT_ID": "acme_zendesk"
      }
    }
  }
}
```

Replace **`acme`** with the company's Zendesk name and **`acme_zendesk`** with
the client identifier they gave you. Leave everything else as it is.

What those two `--namespace` lines mean: `requests` is the customer surface —
submitting and following your own tickets. `help_center` lets the assistant
search the company's help articles, which often answers the question without a
ticket at all. Drop that second one if you'd rather it didn't.

Then restart your assistant so it picks up the change.

### Checking it before you start

If you want to confirm the setup produces what you expect before signing in,
run this in a terminal. It asks the server what tools it would offer and then
exits — no sign-in, no connection to Zendesk:

```bash
npx -y @fruggr/zendesk-mcp-server acme --print-tools \
  --namespace requests --namespace help_center
```

You should see `zendesk_requests` listed with seven operations under it.

---

## Signing in

You don't sign in up front. The first time you actually ask your assistant to
do something with Zendesk, a browser window opens on the company's sign-in
page. Sign in there, and approve the request for access.

That's it. The permission is remembered on your computer, so you won't be asked
again for a while.

**If the browser doesn't open**, the terminal prints a web address — copy it
into your browser yourself.

The sign-in has to happen in a real browser; there is no way to script it. That
is Zendesk's design, and it's the same protection that stops anyone else from
signing in as you.

---

## Using it

Just describe what you need. Some examples:

> *"I want to report a bug with Acme."*

The assistant will look up what kinds of request Acme accepts, tell you what
the bug form asks for, and ask you those questions — rather than making you
fill in a form. Then it submits it.

> *"Attach this screenshot to that."*

Files go on the request when you submit it, or on any later reply.

> *"What's the status of my tickets?"*

Your requests, with what state each one is in.

> *"Read me the latest on ticket 4312."*

The whole conversation, with each reply attributed — you'll see which messages
came from Acme's support team.

> *"Tell them it's fixed and close it."*

A reply, then the ticket marked solved.

### Two behaviours worth knowing

**Replying to a solved ticket reopens it.** If Acme marked your ticket solved
and you reply, it goes back to open. That's usually what you want, but it is
worth knowing that your message did that.

**You can't always close a ticket yourself.** Zendesk only allows it once
someone at Acme has picked the ticket up. Before that, the assistant will tell
you so instead of pretending it worked — if you want to withdraw a request
nobody has looked at yet, reply saying so and they'll close it.

---

## What you cannot do

By design, and enforced by Zendesk rather than by this tool:

- **See anyone else's tickets.** Only your own, ever.
- **See internal notes.** Support agents write private notes to each other on
  tickets; those never reach you, here or anywhere else.
- **Set priority or urgency.** Say it's urgent in the message — a human reads
  it. Zendesk ignores a priority a customer sets.
- **Search across all tickets, or look up other people.** Those are agent
  tools.

---

## When something goes wrong

**"Permission denied", or the server says the token was refused.**
Your account can reach the company's Zendesk, but not the customer surface.
Usually the help site is closed to self-service. Check that you can sign in at
`https://<company>.zendesk.com/hc` and open a request there by hand; if you
can't, that's the thing to report to them.

**"No request form is available to you."**
The company hasn't published a form for customers. They need to make at least
one ticket form visible to end users. Nothing to fix on your side.

**The browser opens but the sign-in fails, or it loops.**
The OAuth client's redirect URL probably doesn't match. Ask the company to
confirm `http://localhost:27439/callback` is registered on it, exactly, and
that the client is public rather than confidential.

**It worked yesterday and now it asks me to sign in again.**
Normal. Access expires and gets renewed; occasionally you sign in afresh.

The fuller, more technical list:
**[docs/troubleshooting.md](troubleshooting.md)**.

---

← Back to the [README](../README.md).
