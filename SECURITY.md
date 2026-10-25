# Security Policy

Greenhouse is a self-hosted Agent hub for teams: it handles authentication, an
OAuth 2.1 authorization server for external agents, stored third-party credentials
(LLM / media / search keys, email accounts), members' model-gateway keys, the agent
surfaces (`/api/mcp`, `/api/agent`, `/api/gateway/*`), and tool execution. We take
security reports seriously.

## Supported versions

Security fixes land on the **latest stable release line** (3.x) and on `main`. Only tagged releases are considered stable — the
`edge` / `main` builds are unstable by design (see the README
["Releases & stability"](./README.md#releases--stability) and
[RELEASING.md](./RELEASING.md)).

| Version | Supported |
|---|---|
| Latest `3.x` tagged release | ✅ |
| Older tags | ❌ — upgrade to the latest release |
| `main` / `:edge` (unreleased tip) | ⚠️ unstable; fine to reproduce & report against |

Please reproduce against the latest release (or `main`) before reporting.

## Reporting a vulnerability

**Please do not open a public issue, PR, or discussion for a security problem.**

Report privately via either:

1. **GitHub** — the repo's **Security → Report a vulnerability** (private
   GitHub Security Advisory). This is the preferred channel.
2. **Email** — **[INSERT MAINTAINER EMAIL]** if you can't use GitHub.
   <!-- TODO: replace the placeholder with the maintainer's security contact. -->

Please include:

- A description of the issue and its impact.
- Steps to reproduce or a proof of concept (scrub any real secrets/tokens).
- Affected version/commit and deploy mode (docker-compose / `pnpm dev`).
- Any suggested remediation, if you have one.

## What to expect

- We aim to acknowledge a report within **5 business days**.
- We'll work with you on a fix and a coordinated disclosure timeline, and credit
  you in the release notes unless you prefer to stay anonymous.
- Please give us a reasonable window to ship a fix before any public disclosure.

## Scope — areas of particular interest

- **Auth & sessions** — token signing/validation, the fail-closed `assertAuthEnv`
  startup guard, role/feature gating (`super` / `team`).
- **Agent surface** — `/api/mcp` (OAuth 2.1: PKCE, dynamic client registration,
  client credentials, scope narrowing by resource group, token hashing and
  revocation), `/api/agent` (the member's own access token, `confirm: true` for
  writes): tool scoping, cross-user / cross-client isolation (including stored
  `tool_output_read` output), the delete preview round trip.
- **Model gateway** — `/api/gateway/openai/v1`, `/api/gateway/anthropic`: `ghgw_`
  key handling (stored hashed), budget reservation, never forwarding member keys
  or leaking upstream keys / URLs.
- **Secret handling** — encryption of stored provider credentials, workspace
  secrets and email passwords (`PROVIDER_TOKEN_ENCRYPTION_KEY`, AES-256-GCM).
- **Tool execution** — the sandboxed `compute` tool, the per-member cloud computer
  (E2B), file/upload handling, SSRF in outbound fetch (search, page reads, email),
  prompt-injection of the agent.
- **Injection** — path traversal, SQL/FTS injection, XSS in rendered content.

There is an automated e2e security suite (`pnpm test:e2e`, see `tests/e2e`) that
covers many of these boundaries — a failing/expanded case there is a great way
to demonstrate a finding.

## Out of scope

- Issues that require a misconfigured deploy that ignores the documented
  fail-closed requirements (e.g. running without `TOKEN_SIGNING_KEY` — the server
  refuses to start without it by design — or without `PROVIDER_TOKEN_ENCRYPTION_KEY`,
  which every stored secret needs).
- Local development credentials in `.env.example` (placeholders) or the bundled
  local Postgres defaults.
