#!/usr/bin/env bash
#
# Live-server E2E security suite — one command, used by CI and locally.
#
# Seeds a disposable active super user, boots the API with a test signing key
# and a deliberately-unreachable LLM endpoint (chat/title calls fail fast — no
# real egress, no cost), waits for /health, runs the vitest e2e suite, then
# tears the server down and cascades the fixture user away. The suite asserts
# security boundaries (status codes / isolation / headers), never model output.
#
# Requires a migrated Postgres (CI provisions it in the `e2e` job; locally):
#   docker run -d --name greenhouse-e2e-pg -e POSTGRES_DB=greenhouse_e2e \
#     -e POSTGRES_USER=greenhouse -e POSTGRES_PASSWORD=greenhouse \
#     -p 127.0.0.1:5439:5432 postgres:16-alpine
#   DATABASE_URL=postgresql://greenhouse:greenhouse@localhost:5439/greenhouse_e2e npx drizzle-kit migrate
#
# Usage:
#   pnpm test:e2e:ci                 # defaults below
#   DATABASE_URL=... pnpm test:e2e:ci
# Only loopback databases whose name contains test/e2e are accepted — never
# point this at a shared dev/prod database.

set -uo pipefail

# Port and signing key must match tests/e2e/helpers.ts; the real user UUID is
# exported after the seed step below.
export API_PORT="${API_PORT:-3999}"
export API_HOST="127.0.0.1"
export TOKEN_SIGNING_KEY="${TOKEN_SIGNING_KEY:-6666666666666666666666666666666666666666666666666666666666666666}"
# Any valid 32-byte hex key — lets the provider-token suites exercise the
# encrypted path instead of the "not configured" 503 branch.
export PROVIDER_TOKEN_ENCRYPTION_KEY="${PROVIDER_TOKEN_ENCRYPTION_KEY:-0000000000000000000000000000000000000000000000000000000000000000}"
export DATABASE_URL="${DATABASE_URL:-postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test}"
# The catalog's default model (`flash`) is an OpenAI-compatible provider read
# from LLM_MODEL / LLM_BASE_URL / LLM_API_KEY. Without a key the provider is
# unavailable and createModelFromConfig throws synchronously (→ /api/chat 500
# before the stream commits), so CI — which has no root .env — must provide one.
# The base URL points at a port that refuses connections so real streaming
# calls fail fast (→ one error event inside a 200 stream, not a 500).
export LLM_API_KEY="${LLM_API_KEY:-sk-e2e-fake}"
export LLM_MODEL="${LLM_MODEL:-e2e-fake-model}"
export LLM_BASE_URL="${LLM_BASE_URL:-http://127.0.0.1:1/v1}"
export LLM_MODEL_PRO=""
# Clear optional provider keys so a local .env can never leak into a real call
# (and so the model picker assertions do not drift with the environment).
export DEEPSEEK_API_KEY=""
export MEDIA_API_KEY=""
export IMAGE_BASE_URL=""
export IMAGE_API_KEY=""
export LOG_LEVEL="${LOG_LEVEL:-error}"
export NODE_ENV="${NODE_ENV:-test}"
# Force local-disk storage so the suite stays hermetic (zero real uploads).
export UPLOADS_S3_ENDPOINT=""
export UPLOADS_S3_BUCKET=""
export TENCENT_CLOUD_COS_SECRET_ID=""
export TENCENT_CLOUD_COS_SECRET_KEY=""
export TENCENT_CLOUD_COS_BUCKET=""
export TENCENT_CLOUD_COS_REGION=""

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_FILE="$(mktemp -t greenhouse-e2e-api.XXXXXX)"
echo "▶ checking destructive E2E database target"
if ! ./node_modules/.bin/tsx tests/e2e/seed-users.ts check; then
  echo "✗ unsafe E2E database target"
  exit 1
fi
echo "▶ seeding active internal E2E identity"
if ! E2E_SUPER_USER_ID="$(./node_modules/.bin/tsx tests/e2e/seed-users.ts seed)"; then
  echo "✗ failed to seed E2E super user"
  exit 1
fi
if [ -z "$E2E_SUPER_USER_ID" ]; then
  echo "✗ E2E identity seed returned an empty user id"
  exit 1
fi
export E2E_SUPER_USER_ID

echo "▶ starting API on :$API_PORT (db: ${DATABASE_URL##*/}, log: $LOG_FILE)"
./node_modules/.bin/tsx apps/api/src/index.ts >"$LOG_FILE" 2>&1 &
API_PID=$!

cleanup() {
  kill "$API_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
  ./node_modules/.bin/tsx tests/e2e/seed-users.ts cleanup "$E2E_SUPER_USER_ID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Wait up to 60s for /health, failing early if the process died.
healthy=0
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "✗ API process exited during startup:"
    cat "$LOG_FILE"
    exit 1
  fi
  sleep 1
done

if [ "$healthy" -ne 1 ]; then
  echo "✗ API did not become healthy within 60s:"
  cat "$LOG_FILE"
  exit 1
fi
echo "✓ API healthy"

echo "▶ running e2e suite (dead-LLM, local storage)"
./node_modules/.bin/vitest run --config vitest.e2e.config.ts
TEST_EXIT=$?

if [ "$TEST_EXIT" -ne 0 ]; then
  echo "──────── API server log ────────"
  cat "$LOG_FILE"
fi

exit "$TEST_EXIT"
