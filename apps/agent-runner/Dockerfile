# greenhouse/agent-runtime — the disposable Mission Sandbox Runner image.
#
# Build FROM THE REPO ROOT (the runner must be compiled first):
#   pnpm --filter @greenhouse/sandbox-runner build
#   docker build -f apps/agent-runner/Dockerfile -t greenhouse/agent-runtime:latest .
# Or use: bash scripts/build-agent-runtime.sh
#
# The process remains uid 0 only for compatibility with existing root-owned
# workspace/session bind mounts. The controller still launches it through
# gVisor (`runsc`) with every Linux capability dropped, no-new-privileges and a
# read-only root filesystem. Only /workspace, /session and declared tmpfs paths
# are writable.

FROM node:22-bookworm-slim

# Debian mirror override for CN-network builds (deb.debian.org is unreachable
# or glacial from the dev machine and the Tencent Cloud server). Examples:
#   --build-arg DEBIAN_MIRROR=mirrors.tuna.tsinghua.edu.cn   (local)
#   --build-arg DEBIAN_MIRROR=mirrors.tencentyun.com          (CVM intranet)
ARG DEBIAN_MIRROR=
# Public mirror baked into the image as reproducibility metadata. Runtime apt
# cannot mutate the read-only root filesystem; all required OS packages must be
# added here and rebuilt. Keeping this public still makes interactive local
# diagnostics usable when the image is launched outside hardened Mission mode.
ARG RUNTIME_DEBIAN_MIRROR=
ARG NPM_REGISTRY=https://registry.npmjs.org
# Same build-vs-shipped split for Python. The system venv is immutable in a
# Mission; a caller may still use this index with an explicit writable
# `--target /workspace/...` during local diagnostics.
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG RUNTIME_PIP_INDEX_URL=https://pypi.org/simple

# Sandbox toolchain. Everything the agent can plausibly need is BAKED IN,
# because runtime `apt-get` inside the sandbox is at the mercy of the egress
# lockdown and mirror reachability — a 2026-07-31 mission burned 29 minutes and
# 60 model requests hand-rolling a DCTDecode JPEG extractor because
# poppler-utils was missing and apt couldn't reach a mirror. Groups:
#   coding     git ripgrep curl ca-certificates procps (ps, for the bash tool)
#   shell      unzip zip xz-utils jq file less — reflexive reaches, all tiny
#   documents  poppler-utils (pdftotext/pdftoppm), pandoc, imagemagick
#   rendering  chromium + fonts → the html2pdf/html2png pair below. CJK fonts
#              are NOT optional: every deliverable this team ships is mixed
#              zh/en, and a renderer without them silently emits tofu boxes.
#   python     interpreter + venv; packages land in /opt/venv in the next layer
#
# NOT installed, deliberately: libreoffice (~1.5 GB, and no first-party skill's
# delivery path needs it — python-pptx/docx/openpyxl generate, pandoc converts).
# imagemagick keeps Debian's default policy.xml, which blocks PDF/PS; rasterize
# PDFs with pdftoppm instead of weakening a security default.
#
# ⚠️ The build mirror is NOT the diagnostic metadata baked into the image: on a Tencent CVM
# `mirrors.tencentyun.com` resolves to the LINK-LOCAL 169.254.0.3, which the
# sandbox egress lockdown rejects along with the metadata endpoint. Mission's
# root filesystem is read-only, so runtime apt is intentionally unsupported;
# use the intranet mirror only to build and keep public metadata for local
# diagnostics outside hardened Mission mode.
#
# ⚠️ This layer MUST retry as a whole. It pulls ~320 MB across 250 .debs, and a
# CN mirror under that much sustained load starts answering 502 on the odd
# package — which killed four consecutive builds on 2026-08-01, each time after
# six minutes of downloading. `Acquire::Retries` does NOT cover this: it retries
# connection failures, not an HTTP 502 response. What does work is re-running
# apt, because the .debs it already fetched stay in /var/cache/apt/archives, so
# each attempt only re-downloads what actually failed. Pipeline-Depth=0 lowers
# the odds of provoking it in the first place (apt pipelines 10 deep by default).
RUN if [ -n "$DEBIAN_MIRROR" ]; then \
    sed -i "s|deb.debian.org|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources; \
  fi \
  && APT_OPTS="-o Acquire::Retries=5 -o Acquire::http::Pipeline-Depth=0" \
  && apt-get $APT_OPTS update \
  && installed=0 \
  && for attempt in 1 2 3 4 5; do \
    if apt-get $APT_OPTS install -y --no-install-recommends \
      git ripgrep curl ca-certificates procps \
      unzip zip xz-utils jq file less \
      poppler-utils pandoc imagemagick \
      chromium fontconfig fonts-noto-cjk fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
      python3 python3-venv; \
    then installed=1; break; fi; \
    echo "[build] apt attempt ${attempt} hit a mirror error; cached .debs are kept, retrying"; \
    sleep 10; \
  done \
  && [ "$installed" = 1 ] \
  && rm -rf /var/lib/apt/lists/* \
  && sed -i "s|${DEBIAN_MIRROR:-deb.debian.org}|${RUNTIME_DEBIAN_MIRROR:-deb.debian.org}|g" \
    /etc/apt/sources.list.d/debian.sources

# Python lives in a baked venv. Mission containers mount the root filesystem
# read-only, so this environment is intentionally immutable at runtime.
ENV VIRTUAL_ENV=/opt/venv
ENV PATH=/opt/venv/bin:$PATH
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
# Document generation (docx/pptx/xlsx/pdf), analysis (pandas), scraping and
# imaging. No matplotlib: brand deliverables mandate inline SVG charts, which
# chromium already renders — see the html2pdf / html2png wrappers below.
RUN python3 -m venv "$VIRTUAL_ENV" \
  && pip install --no-cache-dir \
    pandas openpyxl python-docx python-pptx pypdf pillow requests beautifulsoup4 lxml \
  && printf '[global]\nindex-url = %s\n' "$RUNTIME_PIP_INDEX_URL" > /etc/pip.conf

# Blessed HTML→PDF / HTML→PNG wrappers (chromium needs non-obvious mandatory
# flags in this container; see the scripts).
COPY apps/agent-runner/docker/bin/ /usr/local/bin/
RUN chmod 0755 /usr/local/bin/html2pdf /usr/local/bin/html2png

# Runner dependencies (pi-coding-agent) — plain npm, no workspace involved.
WORKDIR /opt/runner
COPY apps/agent-runner/docker/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund --registry "$NPM_REGISTRY" && npm cache clean --force

# Greenhouse brand typefaces — Nunito (titles) + Nunito Sans (body), the families
# every first-party slides/pdf/report skill asks for. VENDORED variable TTFs
# (docker/fonts/, OFL), not an apt package (Debian ships neither) and NOT a
# build-time download: fetching assets during the build has bitten this image
# twice (the sources.list link-local trap, the TUNA 502 storm), and a font that
# is missing at render time fails silently — chromium falls back to system-ui
# and the "branded" deck quietly loses its typeface. Baking the bytes in is the
# only way the brand face is guaranteed present. fontconfig (from the apt layer)
# indexes them; the family names inside the files are "Nunito"/"Nunito Sans"
# regardless of filename, so `font-family: Nunito` resolves. Placed late so the
# expensive apt/pip/npm layers stay cached when only the fonts change.
COPY apps/agent-runner/docker/fonts/ /usr/share/fonts/truetype/greenhouse/
# Assert via fc-match, not `fc-list | grep`: a variable font lists its family as
# a comma-joined string ("Nunito,Nunito ExtraLight:style=…"), so there is no
# literal "Nunito:" to grep. fc-match resolves the family the way chromium will
# and falls back to another face when it is absent, so grepping its answer is a
# true present/absent test that fails the build if the COPY ever regresses.
RUN fc-cache -f \
  && fc-match Nunito | grep -qi nunito \
  && fc-match 'Nunito Sans' | grep -qi nunito

# Compiled runner (tsc output of apps/agent-runner/src).
COPY apps/agent-runner/dist/ ./dist/

# Pi discovers team skills at $HOME/.agents/skills — the controller bind-mounts
# them read-only. /workspace and /session are bind-mounted per run.
ENV HOME=/home/agent
RUN mkdir -p /home/agent /workspace /session

WORKDIR /workspace
CMD ["node", "/opt/runner/dist/index.js"]
