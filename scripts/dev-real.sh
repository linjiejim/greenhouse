#!/bin/sh
# A local stack with real services, for trying the app by hand: the model, search and keys come
# from an env file outside the repo (default: the main checkout's .env), computers run on this
# machine's Docker. The database persists between runs; the first run seeds the browser-test
# people (apps/web/e2e/env.ts). Ctrl-C stops all of it.
#   sh scripts/dev-real.sh                       (web on 4570, API on 4571)
#   REAL_ENV_FILE=/path/.env sh scripts/dev-real.sh
set -e
cd "$(dirname "$0")/.."
WEB=${REAL_WEB_PORT:-4570}
API=${REAL_API_PORT:-4571}
ENV_FILE=${REAL_ENV_FILE:-$HOME/Code/greenhouse/.env}
DB=${REAL_DATABASE_URL:-postgresql://greenhouse:greenhouse@localhost:55432/greenhouse_v2_local_e2e}
[ -f "$ENV_FILE" ] || { echo "No env file at $ENV_FILE"; exit 1; }
trap 'kill 0' INT TERM EXIT
name=${DB##*/}
if ! docker exec greenhouse-v2-pg psql -U greenhouse -lqt | cut -d'|' -f1 | grep -qw "$name"; then
  E2E_DATABASE_URL=$DB node --import tsx apps/web/e2e/seed.mts
fi
GREENHOUSE_ENV_FILE=$ENV_FILE NODE_ENV=development PORT=$API PUBLIC_URL=http://127.0.0.1:$WEB \
  DATABASE_URL=$DB MIGRATE_ON_START=1 \
  TOKEN_SIGNING_KEY=$(printf 'a%.0s' $(seq 64)) PROVIDER_TOKEN_ENCRYPTION_KEY=$(printf 'b%.0s' $(seq 64)) \
  VAULT_ENCRYPTION_KEY=$(printf 'c%.0s' $(seq 64)) \
  SEARCH_PROVIDER=${SEARCH_PROVIDER:-tavily,firecrawl} \
  SANDBOX_PROVIDER=docker SANDBOX_IMAGE=${SANDBOX_IMAGE:-greenhouse/bot-computer:latest} \
  SANDBOX_DOCKER_RUNTIME=${SANDBOX_DOCKER_RUNTIME:-runc} \
  STORAGE_PROVIDER=local STORAGE_ROOT="${TMPDIR:-/tmp}/greenhouse-v2-local-files" LOG_LEVEL=info \
  node --import tsx apps/api/src/index.ts &
GREENHOUSE_API=http://127.0.0.1:$API WEB_PORT=$WEB pnpm --filter @greenhouse/web exec vite --host 127.0.0.1
