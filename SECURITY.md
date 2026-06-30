# Security Policy

Greenhouse is an AI-native agent workbench: it handles authentication, stored
third-party credentials (LLM gateway keys, email accounts), an external/public
agent surface (`/api/v1/*`, `/api/mcp`, `/api/agent`), and tool execution. We
take security reports seriously.

## Supported versions

The project is pre-1.0 and moves fast. Security fixes land on the latest `main`
(current `0.1.x`). Please reproduce against `main` before reporting.

## Reporting a vulnerability

**Please do not open a public issue, PR, or discussion for a security problem.**

Report privately via either:

1. **GitHub** — the repo's **Security → Report a vulnerability** (private
   GitHub Security Advisory). This is the preferred channel.
2. **Email** — **[INSERT MAINTAINER EMAIL]** if you can't use GitHub.

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
  startup guard, role/feature gating (`super` / `team` / `external`).
- **External surface** — `/api/v1/*`, `/api/mcp`, `/api/agent`: profile/tool
  scoping, API-key isolation, cross-user/session data isolation.
- **Secret handling** — encryption of stored upstream LLM keys and email
  credentials (`PROVIDER_TOKEN_ENCRYPTION_KEY`, AES-256-GCM).
- **Tool execution** — the sandboxed `compute` tool, file/upload handling, SSRF
  in outbound fetch (search, email), prompt-injection of the agent.
- **Injection** — path traversal, SQL/FTS injection, XSS in rendered content.

There is an automated e2e security suite (`pnpm test:e2e`, see `tests/e2e`) that
covers many of these boundaries — a failing/expanded case there is a great way
to demonstrate a finding.

## Out of scope

- Issues that require a misconfigured deploy that ignores the documented
  fail-closed requirements (e.g. running without `ACCESS_PASSWORD` /
  `TOKEN_SIGNING_KEY` set — the server refuses to start without them by design).
- Local development credentials in `.env.example` (placeholders) or the bundled
  local Postgres defaults.
