# greenhouse/bot-computer — the long-lived personal computer each member's Bots share.
#
# Build (context = this directory, not the repo root):
#   bash scripts/build-bot-computer.sh
#   BOTS_COMPUTER_EXTRA_PACKAGES="libreoffice-writer gimp" bash scripts/build-bot-computer.sh
#
# What runs inside (see rootfs/usr/local/bin/gh-computer), as uid `browser`:
#   Xvnc :0 → openbox + tint2 (bottom panel) → headful Chromium with a
#   persistent profile in /home/browser, plus a watchdog (gh-window) that brings
#   back a minimised browser. VNC and DevTools listen ONLY on 0600 Unix sockets
#   in /tmp/browser; no TCP port is open anywhere in the container.
# The Bot's shell, the member's terminal (gh-term → tmux) and background jobs
# (gh-jobs) run as uid `agent` (`docker exec -u agent`), which cannot reach
# either socket, the X display or the browser profile — so a prompt-injected
# Bot cannot read a password the vault filled into a page.
#
# The image holds no greenhouse credential. The API reaches everything through
# `docker exec` (shell, files, terminal, and `socat STDIO UNIX-CONNECT:…`
# tunnels for VNC and DevTools), so the container publishes no port and never
# needs to reach the API — see docs/specs/20261005-personal-assistant-bots.md §6
# and docs/specs/20261007-bots-computer-p0-p1.md §1.
#
# The controller runs it with `--read-only`, every capability dropped,
# no-new-privileges, a tmpfs /tmp and one named volume on /home; production uses
# gVisor (`runsc`), which is why Chromium runs with --no-sandbox (gVisor is the
# boundary — Chromium's own sandbox needs privileges we drop). Software
# installs therefore land in the agent's home (see
# rootfs/etc/profile.d/greenhouse-agent.sh); the system stays read-only.

FROM debian:trixie-slim

# CN-network builds pass a mirror host (scripts/build-bot-computer.sh defaults
# to TUNA); empty keeps deb.debian.org.
ARG DEBIAN_MIRROR=

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# desktop    tigervnc-standalone-server (Xvnc = X server + VNC in one), openbox,
#            tint2 (taskbar, new-window launcher, clock), x11-xserver-utils
#            (xsetroot), xdotool (window focus), imagemagick (`import` for
#            full-desktop screenshots)
# browser    chromium + CJK/emoji fonts — mixed zh/en pages otherwise render tofu
# plumbing   socat (the exec tunnels), tini (PID 1 / zombie reaping), procps,
#            tmux (the member's terminal survives a page reload)
# work       what a Bot (or the member, in the terminal) reaches for in a shell:
#            git curl wget jq ripgrep unzip zip file less nano vim-tiny sqlite3,
#            python3 + pip/venv/pipx, nodejs + npm, build-essential (native
#            modules, pip sdists), ffmpeg and pandoc (media and documents)
#
# A CN mirror under ~500 MB of sustained pulls answers the odd 502 (the failure
# scripts/build-agent-runtime.sh hit too), so apt retries each file, and a
# failed step is retried on its own — never after a fresh `apt-get update`:
# the base image's docker-clean hook empties the download cache on every
# update, so retrying the whole layer fetched all ~800 packages again.
RUN set -eux; \
    if [ -n "$DEBIAN_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org|http://${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi; \
    retry() { for attempt in 1 2 3 4; do "$@" && return 0; [ "$attempt" = 4 ] || sleep 10; done; return 1; }; \
    retry apt-get -o Acquire::Retries=5 update; \
    retry apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      tigervnc-standalone-server openbox tint2 x11-xserver-utils xdotool imagemagick \
      chromium fonts-noto-cjk fonts-noto-color-emoji fonts-liberation \
      socat tini procps ca-certificates xauth tmux \
      git curl wget jq ripgrep unzip zip file less nano vim-tiny sqlite3 \
      python3 python3-pip python3-venv pipx nodejs npm build-essential \
      ffmpeg pandoc; \
    rm -rf /var/lib/apt/lists/*

# Chromium's own menus, dialogs and error pages in the member's language
# (Debian ships only en-US in `chromium`; we keep zh-CN/zh-TW/en). A layer of its own so the big one
# above stays cached; pinned to the installed browser's version, and skipped
# with a warning when the mirror has already moved on to a newer Chromium.
RUN set -eu; \
    version="$(dpkg-query -W -f='${Version}' chromium)"; \
    retry() { for attempt in 1 2 3 4; do "$@" && return 0; [ "$attempt" = 4 ] || sleep 10; done; return 1; }; \
    retry apt-get -o Acquire::Retries=5 update; \
    if apt-get -o Acquire::Retries=5 install -y --no-install-recommends "chromium-l10n=${version}"; then \
      # Only the languages greenhouse speaks (zh, en): the full set is ~115 MB.
      find /usr/lib/chromium/locales -type f ! -name 'zh-CN*' ! -name 'zh-TW*' ! -name 'en-US*' ! -name 'en-GB*' -delete; \
    else \
      echo "WARN: chromium-l10n ${version} is not on the mirror; the browser's own UI stays English" >&2; \
    fi; \
    rm -rf /var/lib/apt/lists/*

# Operator-chosen extras (BOTS_COMPUTER_EXTRA_PACKAGES in the build script, e.g.
# "libreoffice-writer gimp"): a layer of their own so changing them never
# rebuilds the base set, and before rootfs/ so no package can replace a file of
# ours. Space-separated apt package names (pkg, pkg=version, pkg/release).
# The label is the admin page's only record of what was baked in.
ARG EXTRA_PACKAGES=""
RUN set -euf; \
    packages=$(echo $EXTRA_PACKAGES); \
    if [ -n "$packages" ]; then \
      case "$packages" in \
        *[!-a-zA-Z0-9.+:=~/\ ]*) echo "EXTRA_PACKAGES must be space-separated apt package names, got: $packages" >&2; exit 1 ;; \
      esac; \
      retry() { for attempt in 1 2 3 4; do "$@" && return 0; [ "$attempt" = 4 ] || sleep 10; done; return 1; }; \
      retry apt-get -o Acquire::Retries=5 update; \
      retry apt-get -o Acquire::Retries=5 install -y --no-install-recommends $packages; \
      rm -rf /var/lib/apt/lists/*; \
    fi
LABEL greenhouse.bots.computer.extra-packages="${EXTRA_PACKAGES}"

COPY rootfs/ /

# The API refuses an image whose contract differs from the one it was written
# against (apps/api/src/bots/computer/runtime.ts → IMAGE_CONTRACT). Bump both
# together whenever the entrypoint, sockets, uids, helper CLIs or env contract
# change. 2 = tint2 + gh-window, gh-term, gh-jobs, gh-agent-kill, user-level
# installs in the agent's home, GH_COMPUTER_LANG → LANGUAGE + accept-lang.
# scripts/build-bot-computer.sh adds greenhouse.bots.computer.chromium=<version>
# after the build (the version is only known once apt has installed it).
LABEL greenhouse.bots.computer.contract="2"

# agent (1000) = the Bot's shell, the member's terminal and jobs;
# browser (1001) = display + Chromium.
# /home is one named volume at runtime; Docker seeds an empty volume from this
# layout (ownership and modes included) on first mount — existing volumes never
# see later additions, so every helper creates what it needs in a home lazily.
# runtime.json → /tmp/browser/policy.json: the entrypoint writes the URL
# blocklist the API passes in GH_COMPUTER_URL_BLOCKLIST (greenhouse's own
# origins) at every boot; /tmp is a tmpfs owned by nobody but `browser`.
RUN set -eux; \
    chmod 0755 /usr/local/bin/gh-computer /usr/local/bin/gh-cdp-relay /usr/local/bin/gh-window \
      /usr/local/bin/gh-term /usr/local/bin/gh-jobs /usr/local/bin/gh-agent-kill; \
    chmod 0644 /etc/profile.d/greenhouse-agent.sh /etc/tmux.conf /etc/xdg/tint2/tint2rc \
      /etc/xdg/openbox/rc.xml /usr/local/share/applications/greenhouse-new-window.desktop \
      /opt/greenhouse/new-window.svg; \
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
