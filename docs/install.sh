#!/usr/bin/env bash
#
# Greenhouse installer — served at https://greenhouse.linjiejim.com/install.sh
#
#   curl -fsSL https://greenhouse.linjiejim.com/install.sh | bash
#   curl -fsSL https://greenhouse.linjiejim.com/install.sh | bash -s -- --domain gh.example.com --email you@example.com
#
# Installs a self-hosted Greenhouse with Docker Compose — Postgres, a one-shot
# migration and the app — in one directory (default ~/greenhouse). Running it
# again in the same directory upgrades: .env is kept, the images are pulled again.
#
# The compose file and the env template are read out of the image itself, so they
# always match the version being installed and nothing else is downloaded.
#
# Options (flags, or the environment variables in brackets; anything not given is
# asked for when a terminal is available):
#   --dir DIR             install directory                         [GREENHOUSE_DIR]   (~/greenhouse)
#   --email EMAIL         first administrator: a one-time activation  [GREENHOUSE_ADMIN_EMAIL]
#                         link for this address is printed at the end
#   --domain DOMAIN       serve https://DOMAIN with automatic         [GREENHOUSE_DOMAIN]
#                         certificates (Caddy; ports 80 and 443 must be free
#                         and DOMAIN must already point at this server)
#   --port PORT           HTTP port of the app                        [GREENHOUSE_PORT]  (3000)
#   --url URL             address people open (without --domain)      [GREENHOUSE_URL]
#   --version TAG         image tag                                   [GREENHOUSE_VERSION] (latest)
#   --mirror PREFIX       pull greenhouse, postgres and caddy from     [GREENHOUSE_MIRROR]
#                         PREFIX, e.g. registry.cn-hangzhou.aliyuncs.com/<namespace>
#   --llm-base-url URL    OpenAI-compatible endpoint                  [LLM_BASE_URL]
#   --llm-api-key KEY                                                 [LLM_API_KEY]
#   --llm-model MODEL                                                 [LLM_MODEL]
#                         (all three optional: Administration → Runtime Config later)
#   -y, --yes             never prompt; take defaults
#
# Needs only Docker (with the compose plugin). On Linux, a missing Docker can be
# installed with the official convenience script after you confirm.

set -euo pipefail

REPO_IMAGE="ghcr.io/linjiejim/greenhouse"
DOCS_URL="https://github.com/linjiejim/greenhouse#readme"

GREENHOUSE_DIR="${GREENHOUSE_DIR:-$HOME/greenhouse}"
ADMIN_EMAIL="${GREENHOUSE_ADMIN_EMAIL:-}"
DOMAIN="${GREENHOUSE_DOMAIN:-}"
APP_PORT="${GREENHOUSE_PORT:-}"
APP_URL="${GREENHOUSE_URL:-}"
VERSION="${GREENHOUSE_VERSION:-}"
MIRROR="${GREENHOUSE_MIRROR:-}"
LLM_BASE="${LLM_BASE_URL:-}"
LLM_KEY="${LLM_API_KEY:-}"
LLM_MODEL_NAME="${LLM_MODEL:-}"
ASSUME_YES=0

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

usage() { sed -n '3,33p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || echo "See $DOCS_URL"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) GREENHOUSE_DIR="${2:?--dir needs a value}"; shift 2 ;;
    --email) ADMIN_EMAIL="${2:?--email needs a value}"; shift 2 ;;
    --domain) DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
    --port) APP_PORT="${2:?--port needs a value}"; shift 2 ;;
    --url) APP_URL="${2:?--url needs a value}"; shift 2 ;;
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --mirror) MIRROR="${2:?--mirror needs a value}"; shift 2 ;;
    --llm-base-url) LLM_BASE="${2:?--llm-base-url needs a value}"; shift 2 ;;
    --llm-api-key) LLM_KEY="${2:?--llm-api-key needs a value}"; shift 2 ;;
    --llm-model) LLM_MODEL_NAME="${2:?--llm-model needs a value}"; shift 2 ;;
    -y | --yes) ASSUME_YES=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# ─── Prompts ─────────────────────────────────────────────
# The script itself usually arrives on stdin (curl | bash), so questions go to
# and answers come from the terminal.

HAVE_TTY=0
if [ "$ASSUME_YES" = 0 ] && { : < /dev/tty; } 2> /dev/null; then HAVE_TTY=1; fi

ask() { # ask VAR "Question" "default" [secret]
  local var="$1" question="$2" default="${3:-}" secret="${4:-}" answer=""
  if [ "$HAVE_TTY" = 0 ]; then
    printf -v "$var" '%s' "$default"
    return
  fi
  if [ -n "$default" ]; then printf '%s [%s]: ' "$question" "$default" > /dev/tty; else printf '%s: ' "$question" > /dev/tty; fi
  if [ -n "$secret" ]; then
    IFS= read -rs answer < /dev/tty || true
    printf '\n' > /dev/tty
  else
    IFS= read -r answer < /dev/tty || true
  fi
  printf -v "$var" '%s' "${answer:-$default}"
}

confirm() { # confirm "Question" → 0 for yes; without a terminal, --yes decides
  local answer=""
  if [ "$HAVE_TTY" = 0 ]; then [ "$ASSUME_YES" = 1 ]; return; fi
  printf '%s [Y/n]: ' "$1" > /dev/tty
  IFS= read -r answer < /dev/tty || true
  case "$answer" in [nN]*) return 1 ;; *) return 0 ;; esac
}

# ─── Docker ──────────────────────────────────────────────

install_docker() {
  [ "$(uname -s)" = Linux ] || die "Docker is not installed. Install Docker Desktop (or OrbStack) first: https://docs.docker.com/get-docker/"
  confirm "Docker is not installed. Install it now with the official script from get.docker.com?" ||
    die "Docker is required: https://docs.docker.com/engine/install/"
  local sudo="" script
  [ "$(id -u)" -eq 0 ] || sudo="sudo"
  script="$(mktemp)"
  curl -fsSL https://get.docker.com -o "$script"
  if [ -n "$MIRROR" ]; then $sudo sh "$script" --mirror Aliyun; else $sudo sh "$script"; fi
  rm -f "$script"
  $sudo systemctl enable --now docker > /dev/null 2>&1 || true
}

command -v docker > /dev/null 2>&1 || install_docker
if docker info > /dev/null 2>&1; then
  DOCKER=(docker)
elif command -v sudo > /dev/null 2>&1 && sudo docker info > /dev/null 2>&1; then
  DOCKER=(sudo docker)
else
  die "Docker is installed but not reachable — start it (or add this user to the docker group) and re-run."
fi
"${DOCKER[@]}" compose version > /dev/null 2>&1 || die "The Docker Compose plugin is required ('docker compose')."
command -v curl > /dev/null 2>&1 || die "curl is required."

# ─── Helpers ─────────────────────────────────────────────

rand_hex() {
  if command -v openssl > /dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

env_get() { # env_get KEY → current value in .env (empty when unset)
  [ -f .env ] || return 0
  grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- || true
}

env_set() { # env_set KEY VALUE — replace KEY=… (commented out or not), else append
  local tmp
  tmp="$(mktemp)"
  K="$1" V="$2" awk '
    BEGIN { done = 0; pattern = "^#? *" ENVIRON["K"] "=" }
    $0 ~ pattern && !done { print ENVIRON["K"] "=" ENVIRON["V"]; done = 1; next }
    { print }
    END { if (!done) print ENVIRON["K"] "=" ENVIRON["V"] }
  ' .env > "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}

port_in_use() { (: < "/dev/tcp/127.0.0.1/$1") 2> /dev/null; }

compose() { "${DOCKER[@]}" compose "$@"; }

# ─── Install directory ───────────────────────────────────

mkdir -p "$GREENHOUSE_DIR"
cd "$GREENHOUSE_DIR"
UPGRADE=0
[ -f .env ] && UPGRADE=1

# ─── Images ──────────────────────────────────────────────

image_refs() {
  local tag="${VERSION:-latest}"
  if [ -n "$MIRROR" ]; then
    GREENHOUSE_IMAGE="${MIRROR%/}/greenhouse:${tag}"
    POSTGRES_IMAGE="${MIRROR%/}/postgres:16-alpine"
    CADDY_IMAGE="${MIRROR%/}/caddy:2-alpine"
  else
    GREENHOUSE_IMAGE="${REPO_IMAGE}:${tag}"
    POSTGRES_IMAGE="postgres:16-alpine"
    CADDY_IMAGE="caddy:2-alpine"
  fi
}

if [ "$UPGRADE" = 1 ] && [ -z "$VERSION" ] && [ -z "$MIRROR" ]; then
  GREENHOUSE_IMAGE="$(env_get GREENHOUSE_IMAGE)"
  POSTGRES_IMAGE="$(env_get POSTGRES_IMAGE)"
  CADDY_IMAGE="$(env_get CADDY_IMAGE)"
  [ -n "$GREENHOUSE_IMAGE" ] || image_refs
else
  image_refs
fi
: "${POSTGRES_IMAGE:=postgres:16-alpine}"
: "${CADDY_IMAGE:=caddy:2-alpine}"

say "Pulling ${GREENHOUSE_IMAGE}"
"${DOCKER[@]}" pull "$GREENHOUSE_IMAGE" ||
  die "Could not pull ${GREENHOUSE_IMAGE}. On networks where ghcr.io or Docker Hub is blocked, pass --mirror <registry/namespace>."

# The compose file and env template that ship inside this exact image.
"${DOCKER[@]}" run --rm --entrypoint cat "$GREENHOUSE_IMAGE" /app/docker-compose.ghcr.yml > docker-compose.yml.new
mv docker-compose.yml.new docker-compose.yml
"${DOCKER[@]}" run --rm --entrypoint cat "$GREENHOUSE_IMAGE" /app/.env.example > .env.example

# ─── Configuration (first install only) ──────────────────

if [ "$UPGRADE" = 0 ]; then
  say "Configuring a new instance in ${GREENHOUSE_DIR}"
  while :; do
    [ -n "$ADMIN_EMAIL" ] || ask ADMIN_EMAIL "Email of the first administrator"
    case "$ADMIN_EMAIL" in
      *@*.*) break ;;
      *)
        [ "$HAVE_TTY" = 1 ] || die "--email is required (the first administrator's address)."
        warn "That does not look like an email address."
        ADMIN_EMAIL=""
        ;;
    esac
  done
  [ -n "$DOMAIN" ] || [ "$HAVE_TTY" = 0 ] ||
    ask DOMAIN "Domain for HTTPS (leave empty to serve plain HTTP on a port)"
  DOMAIN="${DOMAIN#https://}"
  DOMAIN="${DOMAIN#http://}"
  DOMAIN="${DOMAIN%%/*}"

  if [ -z "$APP_PORT" ]; then
    APP_PORT=3000
    while port_in_use "$APP_PORT"; do APP_PORT=$((APP_PORT + 1)); done
  fi
  if [ -n "$DOMAIN" ]; then
    APP_URL="https://${DOMAIN}"
  elif [ -z "$APP_URL" ]; then
    host="localhost"
    if [ "$(uname -s)" = Linux ] && command -v hostname > /dev/null 2>&1; then
      host="$(hostname -I 2> /dev/null | awk '{print $1}')"
      [ -n "$host" ] || host="localhost"
    fi
    ask APP_URL "Address people will open" "http://${host}:${APP_PORT}"
  fi
  APP_URL="${APP_URL%/}"

  if [ -z "$LLM_KEY" ] && [ "$HAVE_TTY" = 1 ]; then
    note "Model access (OpenAI-compatible). Press Enter to skip and set it later in Administration → Runtime Config."
    ask LLM_KEY "LLM API key" "" secret
    if [ -n "$LLM_KEY" ]; then
      ask LLM_BASE "LLM base URL" "${LLM_BASE:-https://api.openai.com/v1}"
      ask LLM_MODEL_NAME "Model" "${LLM_MODEL_NAME:-gpt-4o-mini}"
    fi
  fi

  cp .env.example .env
  chmod 600 .env
  env_set TOKEN_SIGNING_KEY "$(rand_hex)"
  env_set PROVIDER_TOKEN_ENCRYPTION_KEY "$(rand_hex)"
  env_set BOOTSTRAP_ADMIN_EMAIL "$ADMIN_EMAIL"
  env_set PUBLIC_BASE_URL "$APP_URL"
  env_set APP_BASE_URL "$APP_URL"
  if [ -n "$LLM_KEY" ]; then
    env_set LLM_API_KEY "$LLM_KEY"
    [ -z "$LLM_BASE" ] || env_set LLM_BASE_URL "$LLM_BASE"
    [ -z "$LLM_MODEL_NAME" ] || env_set LLM_MODEL "$LLM_MODEL_NAME"
  else
    # No placeholder key: an unconfigured model must look unconfigured.
    env_set LLM_API_KEY ""
  fi
  pg_port=5432
  while port_in_use "$pg_port"; do pg_port=$((pg_port + 1)); done
  env_set POSTGRES_BIND "127.0.0.1:${pg_port}"

  if [ -n "$DOMAIN" ]; then
    # The app only listens on loopback; Caddy is the way in and its forwarded
    # client address is the one the rate limits and audit log see.
    env_set GREENHOUSE_DOMAIN "$DOMAIN"
    env_set PORT "127.0.0.1:${APP_PORT}"
    env_set TRUSTED_PROXY_HOPS 1
  else
    env_set PORT "$APP_PORT"
  fi
fi

env_set GREENHOUSE_IMAGE "$GREENHOUSE_IMAGE"
env_set POSTGRES_IMAGE "$POSTGRES_IMAGE"
env_set CADDY_IMAGE "$CADDY_IMAGE"

# ─── HTTPS (Caddy) ───────────────────────────────────────

if [ -n "$(env_get GREENHOUSE_DOMAIN)" ]; then
  cat > Caddyfile << 'CADDY'
# Written by install.sh: HTTPS with automatic certificates for GREENHOUSE_DOMAIN.
{$GREENHOUSE_DOMAIN} {
	encode zstd gzip
	reverse_proxy api:3000
}
CADDY
  cat > docker-compose.override.yml << 'OVERRIDE'
# Written by install.sh (--domain). Merged automatically with docker-compose.yml.
services:
  caddy:
    image: ${CADDY_IMAGE:-caddy:2-alpine}
    restart: unless-stopped
    depends_on:
      - api
    ports:
      - '80:80'
      - '443:443'
      - '443:443/udp'
    environment:
      GREENHOUSE_DOMAIN: ${GREENHOUSE_DOMAIN}
      # A proxy from ~/.docker/config.json reaches every container; the app
      # next door must never be fetched through it (certificates still may).
      NO_PROXY: api,localhost,127.0.0.1
      no_proxy: api,localhost,127.0.0.1
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
OVERRIDE
fi

# ─── Start ───────────────────────────────────────────────

say "Starting Greenhouse"
compose pull --quiet ||
  die "Could not pull the images. On networks where ghcr.io or Docker Hub is blocked, re-run with --mirror <registry/namespace>."
compose up -d --remove-orphans

port_binding="$(env_get PORT)"
probe_port="${port_binding##*:}"
say "Waiting for the app to become healthy"
healthy=0
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${probe_port:-3000}/health" > /dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
[ "$healthy" = 1 ] || die "The app did not become healthy. Inspect it with: cd ${GREENHOUSE_DIR} && ${DOCKER[*]} compose logs api"

APP_URL="$(env_get PUBLIC_BASE_URL)"
echo
say "Greenhouse is running at ${APP_URL}"
link="$(compose logs --no-color api 2> /dev/null | grep 'Activate the first administrator' | tail -n 1 | awk '{print $NF}')"
if [ -n "$link" ]; then
  case "$link" in /*) link="${APP_URL}${link}" ;; esac
  note "Open this one-time link to set the administrator's password (valid 72 hours;"
  note "a restart issues a new one and prints it in the log):"
  echo
  printf '    %s\n' "$link"
  echo
elif [ "$UPGRADE" = 0 ]; then
  # An image older than the activation link: create the administrator by hand.
  note "Create the first administrator with:"
  note "  cd ${GREENHOUSE_DIR} && ${DOCKER[*]} compose exec api pnpm admin:create"
fi
note "Manage it from ${GREENHOUSE_DIR}:"
note "  logs      ${DOCKER[*]} compose logs -f api"
note "  stop      ${DOCKER[*]} compose down   (the data stays in Docker volumes)"
note "  upgrade   run this installer again"
if [ -z "$(env_get LLM_API_KEY)" ]; then
  note "No model is configured yet: Administration → Runtime Config after you sign in."
fi
