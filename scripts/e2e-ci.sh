#!/usr/bin/env bash
#
# Live-server E2E integration suite — one command, used by CI and locally.
#
# Boots the API with test credentials and a deliberately-unreachable LLM
# endpoint (so chat/title calls fail fast — no real egress, no cost), waits for
# /health, runs the vitest e2e suite, then tears the server down. The handful of
# assertions that need a real model to emit answer text are skipped via
# E2E_NO_LLM=1 (see tests/e2e/v1-api.e2e.test.ts).
#
# Requires a migrated Postgres at DATABASE_URL (default: greenhouse_test on
# localhost). In CI the `e2e` job provisions it; locally:
#   createdb greenhouse_test && DATABASE_URL=...greenhouse_test npx drizzle-kit migrate
#
# Usage:
#   pnpm test:e2e:ci                 # defaults below
#   DATABASE_URL=... pnpm test:e2e:ci

set -uo pipefail

# Both must match the values tests/e2e/helpers.ts signs tokens with.
export API_PORT="${API_PORT:-3999}"
export ACCESS_PASSWORD="${ACCESS_PASSWORD:-test-secret}"
export TOKEN_SIGNING_KEY="${TOKEN_SIGNING_KEY:-test-secret}"
# Any valid 32-byte hex key — lets the api-client / llm-gateway suites exercise
# encrypted fields instead of hitting the "not configured" 503 path.
export PROVIDER_TOKEN_ENCRYPTION_KEY="${PROVIDER_TOKEN_ENCRYPTION_KEY:-0000000000000000000000000000000000000000000000000000000000000000}"
export DATABASE_URL="${DATABASE_URL:-postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test}"
export LLM_API_KEY="${LLM_API_KEY:-sk-e2e-fake}"
export LLM_MODEL="${LLM_MODEL:-gpt-4o-mini}"
# Unreachable on purpose: LLM calls fail fast (connection refused) so the suite
# never makes a real request. E2E_NO_LLM skips the content-dependent assertions.
export LLM_BASE_URL="${LLM_BASE_URL:-http://127.0.0.1:1/v1}"
export LOG_LEVEL="${LOG_LEVEL:-error}"
export NODE_ENV="${NODE_ENV:-test}"
export E2E_NO_LLM=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_FILE="$(mktemp -t gh-e2e-api.XXXXXX)"
echo "▶ starting API on :$API_PORT (db: ${DATABASE_URL##*/}, log: $LOG_FILE)"
./node_modules/.bin/tsx apps/api/src/index.ts >"$LOG_FILE" 2>&1 &
API_PID=$!

cleanup() {
  kill "$API_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait up to 60s for the server to answer /health, failing early if it crashed.
healthy=0
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$API_PORT/health" >/dev/null 2>&1; then
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

echo "▶ running e2e suite (E2E_NO_LLM=1)"
./node_modules/.bin/vitest run --config vitest.e2e.config.ts
TEST_EXIT=$?

if [ "$TEST_EXIT" -ne 0 ]; then
  echo "──────── API server log ────────"
  cat "$LOG_FILE"
fi

exit "$TEST_EXIT"
