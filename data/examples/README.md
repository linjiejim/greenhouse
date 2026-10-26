# Example dataset (seed data)

A small, realistic, **de-identified** dataset for a fictional company — **Greenhouse
Labs**, a B2B product-analytics startup — used to explore and validate a fresh
Greenhouse install. Not "too much data", but enough to light up every major
feature.

## How to load

```bash
# 1. Bring up Postgres and apply the schema (fresh DB — migrate, never push)
docker compose up -d postgres
pnpm db:migrate

# 2. Load the example dataset (wipes existing rows first)
pnpm seed
```

Then log in at the app with any seeded user and the shared demo password:

| Login | Role | Try |
|---|---|---|
| `maya@greenhouse.example` | super admin | admin, all settings, everything |
| `leo@greenhouse.example` | team | engineering docs, SOC 2 project |
| `priya@greenhouse.example` | team | roadmap, projects, launch |
| `sam@greenhouse.example` | team | brand voice, blog drafts, custom profile |

**Password for every seeded user: `greenhouse`** (override with
`pnpm seed --password <pw>`). `dana@greenhouse.example` is intentionally
**disabled** (offboarding demo) and cannot log in.

Flags: `pnpm seed --keep` loads without wiping first; `--password <pw>` sets the
shared demo password.

## File format

- One file per table; the filename **is** the table name.
- Each file is **JSONL** — one JSON object (one row) per line — so files are easy
  to diff, append to, and stream-import. `//` line comments and blank lines are
  ignored.
- Files load in a fixed FK-safe order (see `LOAD_ORDER` in
  [`apps/api/src/cli/commands/seed.ts`](../../apps/api/src/cli/commands/seed.ts)).

### Authoring conventions

- **Explicit ids.** Rows carry explicit primary keys so cross-table references
  line up (`tasks.project_id`, `messages.session_id`, `shares.resource_id`,
  …). Every id is text; a number in a file is stored as its string (the app's
  own rows get prefixed ULIDs, so they never collide).
- **jsonb columns** (`tags`, `dependencies`, `parts`, `meta`, `_questions`,
  `notify`, …) are authored as **native arrays/objects**. Custom agents (`run_profiles.json`) and automations (`automations.json`, with a `notify` object) are plain rows.
- **Secrets are never baked in.** `users.json` rows carry a plaintext `password`
  (not `password_hash`); the importer scrypt-hashes it at load. Tables whose
  values are encrypted/hashed with the instance secret (`email_accounts`) are
  intentionally **not** seeded.
- **Knowledge docs** are authored as canonical Markdown in `content` only; the
  importer derives `content_json` (Tiptap state) exactly like the runtime
  `knowledge_mutation` tool.

## What's covered (Tiers 1–3)

**Identity & access** — 5 users (super / team / disabled).

**Knowledge base** — 12 docs spanning team vs private visibility,
published / draft / archived status, AI enrichment (`_summary` / `_questions` /
`_topics`), tags, version history (roadmap + handbook), and private-doc sharing
with two users (reader and editor).

**Projects** — 3 projects (Website Relaunch, Q3 Product Launch, SOC 2), members,
14 tasks with subtasks / dependencies / mixed status, comments, and an activity
log (`audit_events` rows with `app_id='projects'`).

**Chat** — 5 conversations (`conversations.json`) on the `web` channel, showing tool
pipelines (`knowledge_query`, `external_search`, `project_query`, `analyze_image`)
and KB citations in `messages.parts`, reasoning, and a shared conversation
(`conversation_shares.json` + `conversation_share_reads.json`).

**Power features** — quick prompts (`prompts`, global + personal), user memories
(`memories`), scheduled automations (`automations`, cron), feature requests
(`feedback` with `kind='request'`, all statuses), one custom agent (`run_profiles`),
and per-user feature flags (`user_grants` with `kind='feature'`).

## Not seeded (and why)

- `auth_refresh_tokens` — ephemeral, minted at login.
- `email_accounts` — values are encrypted with the instance secret;
  bind mailboxes in Settings → Email.
- `usage_events`, `request_log`, `runs` — telemetry, produced by real usage.

Memory and Feedback JSONL files now live in `plugins/memory/seeds` and `plugins/feedback/seeds`; seed loads only enabled plugin contributions after core rows.
