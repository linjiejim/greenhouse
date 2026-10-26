# Self-hosting and upgrades

[← Overview](../README.md) · [Local development](development.md#quick-start-local-development)

## One-command Docker deploy

The bundled `docker-compose.yml` runs Postgres, a one-shot migration job, and the API
(which serves the SPA) as a single self-contained image.

```bash
cp .env.example .env && ./scripts/gen-secrets.sh   # fills required secrets
#   edit .env: set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
docker compose up -d --build
docker compose exec api pnpm admin:create          # create the first super-admin
```

The app is then at http://localhost:3000.

Prefer the published image over a source build? Use
[`docker-compose.ghcr.yml`](../docker-compose.ghcr.yml) instead — same stack, but it
pulls `ghcr.io/linjiejim/greenhouse` (no Node/pnpm toolchain needed):

```bash
docker compose -f docker-compose.ghcr.yml up -d    # defaults to :latest; pin a 3.x tag via GREENHOUSE_IMAGE in .env
```

## Releases & stability

**Use a tagged release in production.** Two channels, and they are not equally
stable:

| You want… | Use | Stability |
|---|---|---|
| A version to run in production | A **tagged release** `vX.Y.Z` — [Releases](https://github.com/linjiejim/greenhouse/releases) · image `ghcr.io/linjiejim/greenhouse:X.Y.Z` (or `:X.Y`) | **Stable** — a cut we stand behind |
| The bleeding edge / to test `main` | `ghcr.io/linjiejim/greenhouse:edge` (or `:main-<sha>`) | **Unstable** — CI builds off `main`; may break between releases |

What the release workflow (`.github/workflows/release.yml`) does today: a `v*` tag publishes
`:X.Y.Z` and `:X.Y`; a push to `main` publishes `:edge` and `:main-<sha>`. It never moves
`:latest`, so `docker-compose.ghcr.yml` (which defaults to `:latest`) should be pinned to a 3.x
tag with `GREENHOUSE_IMAGE`. The image carries its version and commit as the
`APP_VERSION` / `APP_REVISION` environment variables and the matching OCI labels;
`GET /health` reports database status, the runtime kill-switches and the push switch, not the
version.

The **mobile app** ships on its own cadence via EAS (`.github/workflows/mobile.yml`, on
`main`): JS-only changes roll out as over-the-air updates; native changes build and upload to
TestFlight. Maintainer runbook: **[RELEASING.md](../RELEASING.md)**.

### Upgrading from 1.x to 3.0

3.0 rebuilds the database schema (72 tables, text ids, jsonb, one table per concept), so a
1.x database is never migrated in place. You create a **new, empty database** and carry the
data into it with one command; the old database is only read, never written, and stays your
rollback path.

- The source must be on **1.6.x** (its migrations through `0013_report_templates`). Upgrade an
  older 1.x install to 1.6 first.
- **2.x databases are refused** — 3.0 can neither run on nor carry a 2.x database.
- Ids are kept (old numeric ids become strings), so links, extension rows that store a user id
  and ids an external agent remembered keep working; connected agents don't re-authorize.
- Extension tables (`crm_*`, …) and `extension_migrations` are copied verbatim. The report (also
  on `--dry-run`) flags extension tables named like a 3.0 core table and says, per extension
  migration, what 3.0 will do with it; a migration marked `-- greenhouse:core-generation 1x` that
  1.x never applied makes 3.0 refuse to start until it is applied on 1.x and the carry repeated.
- Not carried: retired and removed features (evaluation, Missions, Workflows, session tags,
  user groups, document comments / backlinks, table forms / dashboards / in-table automations),
  run events older than 30 days, delivered outbox rows, expired tokens, rate-limit counters and
  request logs older than 30 days. Every skipped row is counted in the report.
- The command is repeatable: a non-empty target is emptied first, so you can re-run it until the
  reconciliation report is clean.

Bare-metal / source checkout:

```bash
./scripts/backup-db.sh                                   # 1. back up the 1.x database
createdb greenhouse_v3                                   # 2. a new, empty database
pnpm cli migrate-from-1x --dry-run \
  --from postgresql://greenhouse:greenhouse@localhost:5432/greenhouse   # 3. report only
pnpm cli migrate-from-1x \
  --from postgresql://greenhouse:greenhouse@localhost:5432/greenhouse \
  --to   postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_v3   # 4. carry
# 5. point DATABASE_URL at greenhouse_v3 and start the 3.0 API
```

Docker (the `migrate` service of the 3.0 image runs the command; stop the API first):

```bash
docker compose stop api
PG_CONTAINER=<your postgres container> ./scripts/backup-db.sh
docker compose exec postgres createdb -U greenhouse greenhouse_v3
docker compose run --rm migrate ./node_modules/.bin/tsx apps/api/src/cli/index.ts migrate-from-1x \
  --from postgresql://greenhouse:greenhouse@postgres:5432/greenhouse \
  --to   postgresql://greenhouse:greenhouse@postgres:5432/greenhouse_v3 --dry-run
# drop --dry-run to carry, then set DATABASE_URL on the migrate and api services to
# …/greenhouse_v3 and `docker compose up -d`
```

Add `--json` for a machine-readable report. The command exits with code 2 when it refuses (a
2.x or pre-1.6 source, a 1.x or foreign target, the same database twice) and with code 3
("Carry failed:") when it stops after it started writing. The target is marked as carrying
until a run completes, so a half-carried database is refused by `pnpm db:migrate` and the API
boot; fix the cause and run the same command again. To roll back, point
the 1.x deployment at the untouched old database; anything written in 3.0 afterwards stays in
the new one.

### Upgrading within 3.x

Database migrations ship inside the image and are applied by a one-shot `migrate`
service **before** the API starts — an upgraded deployment never runs new code
against an old schema, and already-applied migrations are skipped. Optional but
wise before a big jump: `./scripts/backup-db.sh`.

**Coming from 1.x?** 3.0 does not upgrade a 1.x database in place — the `migrate`
service and the API refuse it. Follow [Upgrading from 1.x to 3.0](#upgrading-from-1x-to-30)
above instead of the commands below.

```bash
# Docker, published image (docker-compose.ghcr.yml):
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d

# Docker, built from source (a fork / local checkout):
git pull && docker compose up -d --build

# Bare-metal source checkout:
git pull && pnpm install && pnpm db:migrate   # then restart the API
```

### Historical 1.x upgrade notes

These describe upgrades inside the 1.x line. A 3.0 install starts from the new baseline, so the
tables they mention are simply absent; they are kept for readers still on 1.x.

> **Upgrading to 1.5** — Greenhouse narrows to a team agent hub: members bring their own
> agents over MCP, and the in-app agent is an assistant. The desktop app (Tauri shell) is
> removed — use the web app in a browser; installed shells stop receiving updates. The browser
> extension (Greenhouse Bridge) is removed and no longer attached to releases; conversations it
> started stay readable and keep their read-only tool face. Session tags and custom session
> folders are removed from the web and mobile apps (`/api/session-tags`, `/api/session-groups`
> are gone; pinning stays). There is no migration: the tables stay untouched in 1.5 and are
> dropped in the next release. Sub-sessions (the `spawn_session` tool and its background
> Subagent runs) are removed: Subagent runs still active at upgrade are closed on first boot,
> historical ones stay readable in the Execution center, and `RUNTIME_SUBAGENT_DRIVER_ENABLED`
> can be removed from `.env`. *My prompts* (formerly the standalone Tasks page, `#/tasks`) moved
> into SkillHub as its second tab, and *My Agents* (`#/agents`) into Automations as the
> *Run profiles* tab; old links redirect. Custom agents, the chat agent picker and
> automations that run as `custom:<id>@<v>` are unchanged.

> **Upgrading to 1.4** — Evaluation, Missions (the cloud-agent sandbox), the team LLM relay
> (`/api/llm`, relay keys, AI Gateway admin page) and Workflows are removed. There is no
> migration: their tables stay untouched so a rollback to 1.3.x keeps working, and are
> dropped in the following release. Old Mission / Workflow conversations stay readable but
> can no longer be continued, historical Eval / Mission / Workflow runs stay readable in the
> Execution center (runs still active at upgrade are closed on first boot), and the
> sandbox host setup (`runsc`, the agent-runtime image, `MISSION_*` / `SANDBOX_RUNNER_*`
> env) can be decommissioned. MCP machine clients and their audit log are unaffected.
> Custom agents lose the review lifecycle (draft → review → pilot → verified) and the
> automatic review worker (`AGENT_GOVERNANCE_ENABLED` can be removed): an agent is private to
> its owner unless a super makes it available to the team, and everyone who picks it gets its
> current version. Agents that were verified or in pilot stay shared; previously archived or
> suspended agents become visible to their owners again. Automations may now run every 15
> minutes.

> **Upgrading from 0.6.x** — this line removes the public/guest surface (`/api/v1`, the
> `default` profile, external accounts) and the database-managed LLM gateway upstreams in
> favour of the model catalog below. The migration retires external accounts, disables
> legacy agent-to-agent API keys, and drops email accounts (they must be re-added under
> Settings → Email with explicit IMAP/SMTP settings). Existing custom agents become
> immutable draft v1 and stay unshared until a super publishes them. Knowledge documents are
> re-tokenized for search on the first boot.

## Configuration

Everything is environment-driven; see [.env.example](../.env.example) for the full list.

**Required** (the server refuses to start without `TOKEN_SIGNING_KEY`; stored secrets need `PROVIDER_TOKEN_ENCRYPTION_KEY`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `TOKEN_SIGNING_KEY` | Signing key for auth tokens (`openssl rand -hex 32`) |
| `PROVIDER_TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for stored secrets — email passwords, integration tokens, workspace-setting secrets (`openssl rand -hex 32`) |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | Any OpenAI-compatible endpoint; the `flash` catalog entry resolves to `LLM_MODEL` (add a stronger `pro` with `LLM_MODEL_PRO`) |

**Model catalog** — `apps/api/src/config/models.yaml` is the single definition of every model
a deployment can use: the built-in `flash` / `pro` entries follow `LLM_*`, and the native
DeepSeek V4.1 Flash entry (`deepseek-flash`) appears in the chat picker as soon as
`DEEPSEEK_API_KEY` is set. Add a provider entry to offer another model; secrets never live in
the file. An optional `price` (USD per 1M input / output / cached-input tokens) feeds metering;
non-model services are priced in `apps/api/src/config/services.yaml`. The default model is treated as multimodal: images attached in Chat go straight into
its payload. Set `LLM_VISION=false` when `LLM_MODEL` is text-only, and images go through
`analyze_image` instead.

Optional: media (vision `analyze_image` + `generate_image` through `MEDIA_*`, falling back to
the LLM endpoint; `IMAGE_BASE_URL` + `IMAGE_API_KEY` move generation alone to an image
provider), external web search, email mailboxes, WeCom / Feishu, usage budgets, and
object storage. Uploads default to local disk (`data/uploads`), SkillHub
bundles to `data/skills` — set all four `SKILLS_S3_*` to keep bundles in S3-compatible storage.

**Admin-configurable at runtime**: the LLM / media / search credentials and the product name
can also be set in **Administration → Runtime Config** (and branding in **Branding Studio**) —
values saved there are stored in the database (secrets encrypted with
`PROVIDER_TOKEN_ENCRYPTION_KEY`), win over the env vars, and apply without a restart.

**Structure lives in code**: [`greenhouse.config.ts`](../greenhouse.config.ts) (typed, validated
at boot) declares which extensions are switched on, where content packs live (skill packs,
agent profiles, a seed dataset) and how client builds (the mobile app) treat server
stations. `GREENHOUSE_EXTENSIONS=example` (a comma-separated list) overrides it per deployment.
