# Example dataset (seed data)

A small, realistic, **de-identified** dataset for a fictional company — **Greenhouse
Labs**, a B2B product-analytics startup — used to explore and validate a fresh
Greenhouse install. Not "too much data", but enough to light up every major
feature.

## How to load

```bash
# 1. Bring up Postgres and apply the schema (fresh DB — migrate, never push)
docker compose up -d postgres
npx drizzle-kit migrate

# 2. Load the example dataset (wipes existing rows first)
pnpm seed
```

Then log in at the app with any seeded user and the shared demo password:

| Login | Role | Try |
|---|---|---|
| `maya@greenhouse.example` | super admin | admin, all settings, everything |
| `leo@greenhouse.example` | team | engineering docs, SOC 2 project, sub-agents |
| `priya@greenhouse.example` | team | roadmap, projects, launch |
| `sam@greenhouse.example` | team | brand voice, blog drafts, custom profile |
| `riley@acme-partner.example` | external | public assistant only |

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
  [`apps/api/src/cli/seed.ts`](../../apps/api/src/cli/seed.ts)).

### Authoring conventions

- **Explicit ids.** Rows carry explicit primary keys so cross-table references
  line up (`tasks.project_id`, `messages.session_id`, `knowledge_base_shares.doc_id`,
  …). After loading a serial-PK table the importer realigns the sequence so the
  app's own inserts don't collide.
- **JSON-as-text columns** (`tags`, `dependencies`, `pipeline`, `references_`,
  `_questions`, `capabilities`, …) are authored as **native arrays/objects**; the
  importer stringifies them for the underlying `text` columns. The one real
  `jsonb` column (`custom_profiles.data`) is inserted as JSON.
- **Secrets are never baked in.** `users.json` rows carry a plaintext `password`
  (not `password_hash`); the importer scrypt-hashes it at load. Tables whose
  values are encrypted/hashed with the instance secret (`api_clients`,
  `llm_upstreams`, `email_accounts`) are intentionally **not** seeded.
- **Knowledge docs** are authored as canonical Markdown in `content` only; the
  importer derives `content_json` (Tiptap state) exactly like the runtime
  `knowledge_mutation` tool.

## What's covered (Tiers 1–3)

**Identity & access** — 6 users (super / team / external / disabled), profile
assignments, 2 groups + membership.

**Knowledge base** — 12 docs spanning team vs private visibility,
published / draft / archived status, AI enrichment (`_summary` / `_questions` /
`_topics`), tags, version history (roadmap + handbook), and private-doc sharing
with a user and a group.

**Projects** — 3 projects (Website Relaunch, Q3 Product Launch, SOC 2), members,
14 tasks with subtasks / dependencies / mixed status, comments, and an activity
log.

**Chat** — 7 sessions across the `web`, `api`, and `subagent` channels, showing
tool pipelines (`knowledge_query`, `external_search`, `project_manager`,
`analyze_image`, `spawn_session`), KB citations, reasoning, ratings, a
parent→child sub-agent lineage, folders, tags, and a shared session.

**Power features** — quick prompts (global + personal), user memories, scheduled
automations (cron), feature requests (all statuses), one shared custom profile,
and per-user feature flags.

## Not seeded (and why)

- `refresh_tokens` — ephemeral, minted at login.
- `api_clients`, `llm_upstreams`, `email_accounts` — values are hashed/encrypted
  with the instance secret; create these via their CLIs / admin UI.
- `llm_calls`, `llm_usage`, `api_audit_log` — telemetry, produced by real usage.
