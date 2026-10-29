# Deploying to a container platform

Greenhouse ships as one container image (`ghcr.io/linjiejim/greenhouse`) that needs a
PostgreSQL database and, optionally, an S3-compatible bucket. Anything that runs a
container next to a database can host it. `docker-compose.yml` in the repository root
remains the reference self-hosted setup; this page covers hosted platforms.

`MIGRATE_ON_START`, `BOOTSTRAP_ADMIN_EMAIL`, `PORT` and `STORAGE_S3_*` need a release newer
than 4.0.0-rc.2. The files here use the `latest` tag, which follows stable releases only;
until a stable 4.x is out, replace it with a newer 4.x tag.

## The contract

| Variable | Required | What it does |
|---|---|---|
| `DATABASE_URL` | yes | Any PostgreSQL (tested on 16; no extensions needed). |
| `TOKEN_SIGNING_KEY` | yes | 64 hex characters: `openssl rand -hex 32`. |
| `PROVIDER_TOKEN_ENCRYPTION_KEY` | yes | 64 hex characters, a different value. Keep it: it decrypts stored credentials. |
| `MIGRATE_ON_START` | recommended | `1` applies database migrations at boot, under a lock. Empty and 4.x databases only; a 3.x database must be backed up and upgraded with `pnpm db:migrate` first. |
| `BOOTSTRAP_ADMIN_EMAIL` | first boot | While nobody administers the instance, each boot logs a one-time activation link for this address. Open it, set a password, and you are the super admin. Inert afterwards. |
| `PUBLIC_BASE_URL` | recommended | The public `https://` address. The activation link in the log is then a full URL, and invite/reset links can be emailed later. |
| `PORT` | set by the platform | The listening port (`API_PORT` wins when both are set; default 3000). |
| `STORAGE_S3_ENDPOINT`, `STORAGE_S3_BUCKET`, `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | without a disk | Uploads, Files and skill bundles go to the bucket instead of `/app/data`. Any store that speaks the S3 API (AWS S3, Cloudflare R2, MinIO, SeaweedFS, Backblaze B2, Tencent COS, Aliyun OSS); files are proxied through Greenhouse, so the bucket needs no CORS setup. Optional `STORAGE_S3_REGION` (default `us-east-1`; R2 uses `auto`) and `STORAGE_S3_FORCE_PATH_STYLE` (default `true`). |

The model, search and other credentials are not deploy variables: sign in and fill them
in under Administration → Runtime Config. The full list of optional variables is in
[`.env.example`](../.env.example).

Requirements the platform must meet:

- One instance, always on. Chat runs, schedules and live updates live in the process, so
  do not scale out and do not scale to zero.
- About 300 MB of memory at idle with the default plugins; give it at least 1 GB (report rendering and parallel chats need headroom).
- Health check: `GET /health`.
- Persistent data: either a volume at `/app/data` or the `STORAGE_S3_*` bucket. Without
  either, uploaded files disappear on every redeploy.
- The image is `linux/amd64`.

First boot: deploy, open the service log, find the line with the activation link, open
it, set a password. The sign-in page also says when an instance is still unclaimed.

## Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/linjiejim/greenhouse)

The Blueprint ([`render.yaml`](../render.yaml)) creates the web service from the image,
a Render Postgres database and a 5 GB disk at `/app/data` on the `standard` plan (2 GB; `starter` has only 512 MB). It asks for the two keys
(`openssl rand -hex 32`, twice), the admin email and `PUBLIC_BASE_URL` (use the
`https://<name>.onrender.com` address Render shows, or your own domain).

## Railway

Create a project with a PostgreSQL service and a service from the image
`ghcr.io/linjiejim/greenhouse:latest`, then set on the Greenhouse service:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
TOKEN_SIGNING_KEY=${{secret(64, "abcdef0123456789")}}
PROVIDER_TOKEN_ENCRYPTION_KEY=${{secret(64, "abcdef0123456789")}}
MIGRATE_ON_START=1
PUBLIC_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
BOOTSTRAP_ADMIN_EMAIL=you@example.com
```

Attach a volume at `/app/data` (or set `STORAGE_S3_*`), generate a public domain and
set the health check path to `/health`. The same settings saved as a Railway template
give a one-click button.

## Fly.io

```bash
fly launch --copy-config --config deploy/fly.toml --no-deploy   # pick an app name and region
fly volumes create greenhouse_data --size 5
fly secrets set TOKEN_SIGNING_KEY=$(openssl rand -hex 32) \
  PROVIDER_TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  DATABASE_URL=postgres://… BOOTSTRAP_ADMIN_EMAIL=you@example.com \
  PUBLIC_BASE_URL=https://<app>.fly.dev
fly deploy --config deploy/fly.toml
```

Use Fly Managed Postgres or any external PostgreSQL for `DATABASE_URL`.

## Zeabur, Sealos, DigitalOcean App Platform, Azure Container Apps

Add a PostgreSQL service and a service from the image, set the variables from the
contract above, expose the port the platform assigns, set the health check to `/health`,
keep exactly one instance, and attach a volume at `/app/data` or set `STORAGE_S3_*`.
DigitalOcean App Platform has no volumes, so it needs the bucket.

## Google Cloud Run and Cloudflare Containers

Both work only with the settings that keep one instance alive: Cloud Run with
minimum and maximum instances 1, CPU always allocated and session affinity; Cloudflare
Containers with a single instance and a long `sleepAfter`. Neither has a volume, so set
`STORAGE_S3_*` (R2 on Cloudflare), and use an external PostgreSQL (Cloud SQL, Neon,
Supabase, PlanetScale). Cloudflare Workers alone cannot run Greenhouse.
