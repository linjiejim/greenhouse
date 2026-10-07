#!/usr/bin/env bash
# Build the greenhouse/bot-computer image — the long-lived computer each
# member's Bots share (docs/specs/20261005-personal-assistant-bots.md §6,
# image contract 2: docs/specs/20261007-bots-computer-p0-p1.md §1).
#
# Run it on the Docker host the computers will live on (the API must run on the
# same host — it reaches every computer through `docker exec`). Afterwards set
# BOTS_COMPUTER_ENABLED=1 in the API's .env; the API creates, starts, idles and
# evicts every member's computer on its own. Rebuild every two weeks or so:
# Chromium runs with --no-sandbox (gVisor is the boundary), so browser security
# updates only arrive with a fresh image — idle computers pick it up on their
# next start.
#
#   BOTS_COMPUTER_IMAGE            tag to build (default greenhouse/bot-computer:latest)
#   BOTS_COMPUTER_EXTRA_PACKAGES   extra apt packages baked in, space-separated
#                                  (e.g. "libreoffice-writer gimp"); recorded in the
#                                  image label the admin page shows
#   DEBIAN_MIRROR                  apt mirror host (default TUNA; empty = deb.debian.org)
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${BOTS_COMPUTER_IMAGE:-greenhouse/bot-computer:latest}"
# CN-network default: TUNA. On a Tencent CVM use DEBIAN_MIRROR=mirrors.tencentyun.com;
# DEBIAN_MIRROR= (empty) builds straight from deb.debian.org.
MIRROR="${DEBIAN_MIRROR-mirrors.tuna.tsinghua.edu.cn}"
# One space between names, none around: the label reads the same however the
# variable was written (newlines, tabs, double spaces).
EXTRA_PACKAGES="$(printf '%s' "${BOTS_COMPUTER_EXTRA_PACKAGES:-}" | tr -s '[:space:]' ' ' | sed -e 's/^ //' -e 's/ $//')"

# The mirror must never go through a developer's docker/http proxy (Clash on
# 127.0.0.1:7890 answers the odd 502 under ~1 GB of apt pulls) — the same
# reason scripts/build-agent-runtime.sh bypasses it.
NO_PROXY_HOSTS="${MIRROR:+${MIRROR},}deb.debian.org,security.debian.org"

build() {
  # --network=host: buildkit's sandboxed build network has no DNS on some hosts
  # (OrbStack + proxy setups) while runtime containers resolve fine.
  docker build --network=host \
    --build-arg DEBIAN_MIRROR="${MIRROR}" \
    --build-arg EXTRA_PACKAGES="${EXTRA_PACKAGES}" \
    --build-arg no_proxy="${NO_PROXY_HOSTS}" \
    --build-arg NO_PROXY="${NO_PROXY_HOSTS}" \
    "$@" \
    -t "${TAG}" apps/bot-computer
}

echo "==> building ${TAG} (apt mirror: ${MIRROR:-deb.debian.org}; extra packages: ${EXTRA_PACKAGES:-none})"
build

# The Chromium version is only known once apt installed it, so it is stamped in
# a second, fully cached pass. The admin page shows it next to the image age.
CHROMIUM_VERSION="$(docker run --rm --network none --entrypoint chromium "${TAG}" --version 2>/dev/null |
  grep -oE '[0-9]+(\.[0-9]+){3}' | head -n1 || true)"
if [ -n "${CHROMIUM_VERSION}" ]; then
  echo "==> labelling chromium ${CHROMIUM_VERSION}"
  build --quiet --label "greenhouse.bots.computer.chromium=${CHROMIUM_VERSION}" >/dev/null
else
  echo "warning: could not read the Chromium version; the image is unlabelled" >&2
fi

echo "==> done: ${TAG}"
docker image inspect "${TAG}" \
  --format 'size: {{.Size}} bytes  id: {{.Id}}  labels: {{json .Config.Labels}}'
