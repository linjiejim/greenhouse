# greenhouse/bot-computer — the long-lived personal computer each member's Bots share.
#
# Build (context = this directory, not the repo root):
#   bash scripts/build-bot-computer.sh
#
# What runs inside (see rootfs/usr/local/bin/gh-computer), as uid `browser`:
#   Xvnc :0 → openbox → headful Chromium with a persistent profile in
#   /home/browser. VNC and DevTools listen ONLY on 0600 Unix sockets in
#   /tmp/browser; no TCP port is open anywhere in the container.
# The Bot's shell enters as uid `agent` (`docker exec -u agent`) and cannot
# reach either socket, the X display or the browser profile — so a prompt-
# injected Bot cannot read a password the vault filled into a page.
#
# The image holds no greenhouse credential. The API reaches everything through
# `docker exec` (shell, files, and `socat STDIO UNIX-CONNECT:…` tunnels for VNC
# and DevTools), so the container publishes no port and never needs to reach
# the API — see docs/specs/20261005-personal-assistant-bots.md §6.
#
# The controller runs it with `--read-only`, every capability dropped,
# no-new-privileges, a tmpfs /tmp and one named volume on /home; production uses
# gVisor (`runsc`), which is why Chromium runs with --no-sandbox (gVisor is the
# boundary — Chromium's own sandbox needs privileges we drop).

FROM debian:trixie-slim

# CN-network builds pass a mirror host (scripts/build-bot-computer.sh defaults
# to TUNA); empty keeps deb.debian.org.
ARG DEBIAN_MIRROR=

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# desktop    tigervnc-standalone-server (Xvnc = X server + VNC in one), openbox,
#            x11-xserver-utils (xsetroot), xdotool (window focus), imagemagick
#            (`import` for full-desktop screenshots)
# browser    chromium + CJK/emoji fonts — mixed zh/en pages otherwise render tofu
# plumbing   socat (the exec tunnels), tini (PID 1 / zombie reaping), procps
# work       git curl jq ripgrep unzip python3 — what a Bot reaches for in a shell
#
# The layer retries as a whole: a CN mirror under ~300 MB of sustained pulls
# answers the odd 502 (the same failure scripts/build-agent-runtime.sh hit).
RUN set -eux; \
    if [ -n "$DEBIAN_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org|http://${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi; \
    for attempt in 1 2 3; do \
      if apt-get update \
         && apt-get install -y --no-install-recommends \
              tigervnc-standalone-server openbox x11-xserver-utils xdotool imagemagick \
              chromium fonts-noto-cjk fonts-noto-color-emoji fonts-liberation \
              socat tini procps ca-certificates xauth \
              git curl jq ripgrep unzip python3; then \
        break; \
      fi; \
      if [ "$attempt" = 3 ]; then exit 1; fi; \
      sleep 5; \
    done; \
    rm -rf /var/lib/apt/lists/*

COPY rootfs/ /

# The API refuses an image whose contract differs from the one it was written
# against (apps/api/src/bots/computer/runtime.ts → IMAGE_CONTRACT). Bump both
# together whenever the entrypoint, sockets, uids or env contract change.
# scripts/build-bot-computer.sh adds greenhouse.bots.computer.chromium=<version>
# after the build (the version is only known once apt has installed it).
LABEL greenhouse.bots.computer.contract="1"

# agent (1000) = the Bot's shell; browser (1001) = display + Chromium.
# /home is one named volume at runtime; Docker seeds an empty volume from this
# layout (ownership and modes included) on first mount.
# runtime.json → /tmp/browser/policy.json: the entrypoint writes the URL
# blocklist the API passes in GH_COMPUTER_URL_BLOCKLIST (greenhouse's own
# origins) at every boot; /tmp is a tmpfs owned by nobody but `browser`.
RUN set -eux; \
    chmod 0755 /usr/local/bin/gh-computer /usr/local/bin/gh-cdp-relay; \
    ln -sf /tmp/browser/policy.json /etc/chromium/policies/managed/runtime.json; \
    groupadd --gid 1100 computer; \
    useradd --create-home --uid 1000 --shell /bin/bash --groups computer agent; \
    useradd --create-home --uid 1001 --shell /usr/sbin/nologin --groups computer browser; \
    mkdir -p /home/agent/work /home/agent/Downloads /home/browser/chromium; \
    chown -R agent:agent /home/agent; \
    chown agent:computer /home/agent/Downloads; \
    chmod 2775 /home/agent/Downloads; \
    chown -R browser:browser /home/browser; \
    chmod 0700 /home/browser

USER browser
WORKDIR /home/browser
ENV HOME=/home/browser DISPLAY=:0

# tini hands `docker stop`'s SIGTERM to gh-computer only, which shuts the box
# down in order (browser first, so the profile is flushed to the volume).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/gh-computer"]
