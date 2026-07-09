# MCP registry namespace ownership (`io.fruggr/*`)

Runbook for proving control of the `fruggr.io` domain to the official MCP
registry, so the server can be published under the `io.fruggr/*` namespace. This
is the durable source of truth for the DNS challenge; it is an **ops enabler**
with a long human lead time (DNS propagation, secret provisioning) and carries
no repo-code dependency.

> **Status.** Preparation only. The DNS record and the CI signing secret are
> **human/ops steps** (see below). Wiring the registry publish to DNS auth in
> `.github/workflows/release.yml` is **out of scope here** — it belongs to the
> identity-migration lot, which consumes the ownership proof established by this
> runbook.

## Why a different auth path

The release pipeline publishes today under `io.github.fruggr/zendesk-mcp-server`
(see [`release-automation.md`](release-automation.md) → *MCP registry
publishing*). That `io.github.fruggr/*` namespace is authorized by **GitHub
OIDC** because the workflow runs inside the `fruggr` org — no secret, no domain
proof.

The migration target `io.fruggr/zendesk-mcp-server` lives in the `io.fruggr/*`
namespace instead. Registry namespaces are **reverse-DNS**: `io.fruggr` maps to
the domain `fruggr.io`, and the registry only grants that namespace to a
publisher that can prove control of `fruggr.io`. **GitHub OIDC does not
authorize `io.fruggr/*`** — the org-membership proof it carries says nothing
about the `fruggr.io` DNS zone. The registry's DNS authentication scheme covers
that gap: an ed25519 keypair whose public half is published as a TXT record on
the domain and whose private half signs the publish.

## Verified procedure

Verified against the official registry authentication docs
(modelcontextprotocol.io/registry/authentication, retrieved 2026-07-09). The
registry is in **preview** and its auth schemes move — before running these,
re-confirm against `./mcp-publisher --help` for the version pinned in the
workflow (`MCP_PUBLISHER_VERSION`, currently `1.7.9`) and the current docs.

**Do not generate the keypair from a throwaway/CI-less context.** Generate it in
the secure environment where the private key will live, load the private key
straight into the GitHub Actions secret, and keep only the public key for DNS.
No private-key material ever lands in this repository.

```sh
# 1. Generate the ed25519 keypair (private key stays local, never committed).
openssl genpkey -algorithm Ed25519 -out key.pem

# 2. Derive the public key (base64) for the DNS TXT record.
PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"

# 3. Derive the private key (64-char hex) for the CI secret / login.
PRIVATE_KEY="$(openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"

# 4. Log in to the registry with the domain + private key.
mcp-publisher login dns --domain fruggr.io --private-key "${PRIVATE_KEY}"
```

## Human step — DNS TXT record

Add the following TXT record on the **apex** of `fruggr.io`. The record must sit
on the apex, **not** under a selector such as `_mcp-auth.fruggr.io`.

```text
fruggr.io. IN TXT "v=MCPv1; k=ed25519; p=<PUBLIC_KEY_BASE64>"
```

`<PUBLIC_KEY_BASE64>` is the `PUBLIC_KEY` from step 2. Record the resolved value
here once the keypair has been generated — this file is the durable source of
truth for the challenge:

<!-- Actual record (fill in once generated), e.g.:
     fruggr.io. IN TXT "v=MCPv1; k=ed25519; p=MCowBQYDK2Vw..." -->

- **Owner:** the person/team with write access to the `fruggr.io` DNS zone.
- **Managed manually** (no IaC assumption). If the zone is later moved to
  infrastructure-as-code, the equivalent TXT resource becomes the source of
  truth instead — update this file accordingly.

## Human step — CI signing secret

Store the **private key** (the `PRIVATE_KEY` hex from step 3) as a repository
**GitHub Actions secret**:

- **Name:** `MCP_REGISTRY_DNS_PRIVATE_KEY`
- **Where:** Settings → Secrets and variables → Actions → *New repository secret*.
- **Never** commit the key or paste it into logs, PRs, or issues.

> The workflow does **not** consume this secret yet. Adding the
> `mcp-publisher login dns --private-key "${{ secrets.MCP_REGISTRY_DNS_PRIVATE_KEY }}"`
> step to `release.yml` is part of the identity-migration lot, after the rename.

## Verify

Once the record has propagated:

```sh
# TXT record is visible on the apex.
dig +short TXT fruggr.io

# The registry accepts the DNS login (authorizes io.fruggr/*).
mcp-publisher login dns --domain fruggr.io --private-key "${PRIVATE_KEY}"
```

A successful `login dns` confirms `fruggr.io` ownership is recognized for the
`io.fruggr/*` namespace.

### Blocking human step, if not yet done

Domain ownership cannot be completed from the repo alone. It is blocked until:

1. the DNS zone owner adds the apex TXT record above, and
2. a repo/org admin stores `MCP_REGISTRY_DNS_PRIVATE_KEY` as a GitHub Actions
   secret.

Both are prerequisites for the identity-migration lot.

## Ordering

Independent of the deprecation lot ([#114](https://github.com/fruggr/zendesk-mcp-server/issues/114))
and the npm-description lot. This ownership proof and #114 both **precede** the
identity-migration lot (the `io.fruggr` rename + versioned `server.json`), which
consumes both.
