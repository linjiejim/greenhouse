#!/usr/bin/env bash
#
# Greenhouse — fill required secrets in .env with random values if they are empty.
# Idempotent: existing non-empty values are left untouched.
#
#   ./scripts/gen-secrets.sh           # operates on ./.env (created from .env.example if missing)
#   ./scripts/gen-secrets.sh path/.env
#
set -euo pipefail

ENV_FILE="${1:-.env}"
if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  echo "created $ENV_FILE from .env.example"
fi

gen() { openssl rand -hex 32; }

fill() {
  local key="$1" val
  # Set if the key is missing entirely OR present with an empty/placeholder value.
  if grep -qE "^${key}=.+" "$ENV_FILE" && ! grep -qE "^${key}=(change-me)?$" "$ENV_FILE"; then
    echo "${key} already set — skipping"
    return
  fi
  val="$(gen)"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    printf '\n%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
  echo "generated ${key}"
}

fill ACCESS_PASSWORD
fill TOKEN_SIGNING_KEY
fill PROVIDER_TOKEN_ENCRYPTION_KEY

echo
echo "Done. Next: set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL in $ENV_FILE, then:"
echo "  docker compose up -d --build"
