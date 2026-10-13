#!/bin/sh
# A local stack for looking at the web app by hand: a fresh database, the fake model, the API and
# Vite, on their own ports so the browser tests can run beside it. Ctrl-C stops all of it.
#   sh apps/web/e2e/stack.sh            (web on 4580)
set -e
cd "$(dirname "$0")/../../.."
WEB=${STACK_WEB_PORT:-4580}
API=${STACK_API_PORT:-4581}
LLM=${STACK_LLM_PORT:-4582}
export E2E_DATABASE_URL=${STACK_DATABASE_URL:-postgresql://greenhouse:greenhouse@localhost:55432/greenhouse_v2_preview_e2e}
trap 'kill 0' INT TERM EXIT
node --import tsx apps/web/e2e/seed.mts
node apps/web/e2e/fake-llm.mjs "$LLM" &
GREENHOUSE_ENV_FILE=/dev/null NODE_ENV=development PORT=$API PUBLIC_URL=http://127.0.0.1:$WEB \
  DATABASE_URL=$E2E_DATABASE_URL TOKEN_SIGNING_KEY=$(printf 'a%.0s' $(seq 64)) \
  PROVIDER_TOKEN_ENCRYPTION_KEY=$(printf 'b%.0s' $(seq 64)) LLM_PROVIDER=openai-compatible \
  LLM_BASE_URL=http://127.0.0.1:$LLM/v1 LLM_API_KEY=sk-e2e LLM_MODEL=fake LOG_LEVEL=warn \
  STORAGE_PROVIDER=local STORAGE_ROOT="${TMPDIR:-/tmp}/greenhouse-v2-preview-files" \
  node --import tsx apps/api/src/index.ts &
GREENHOUSE_API=http://127.0.0.1:$API WEB_PORT=$WEB pnpm --filter @greenhouse/web exec vite --host 127.0.0.1
