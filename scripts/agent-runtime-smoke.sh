#!/usr/bin/env bash
# Smoke-test the Mission Sandbox Runner image: does the sandbox actually have the
# delivery toolchain the runner advertises, and does it work end to end?
#
# The load-bearing check is the Chinese HTML → PDF → text round-trip: it fails
# if chromium is missing, if the container's root/--cap-drop ALL combination
# breaks chromium's sandbox, if CJK fonts are absent (text renders as tofu and
# does not come back out), or if poppler is missing. One assertion, four ways
# to catch a broken image.
#
#   bash scripts/agent-runtime-smoke.sh [image-tag]
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:-${SANDBOX_RUNNER_IMAGE:-${CLOUD_AGENT_IMAGE:-greenhouse/agent-runtime:latest}}}"
RUNTIME="${SANDBOX_RUNNER_DOCKER_RUNTIME:-runsc}"
CONTAINER="greenhouse-sandbox-smoke-$$"
echo "==> smoke-testing ${TAG}"

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Mirror the controller's real container flags (apps/api/src/cloud-agent/docker.ts):
# a tool that only works with default capabilities is not a tool this image has.
docker run -d --name "${CONTAINER}" \
  --runtime "${RUNTIME}" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --log-driver local \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --tmpfs /home/agent:rw,nosuid,nodev,size=64m \
  --memory 1.5g \
  --cpus 2 \
  --pids-limit 512 \
  --entrypoint /bin/sleep \
  "${TAG}" 600 >/dev/null

actual_runtime="$(docker inspect "${CONTAINER}" --format '{{.HostConfig.Runtime}}')"
[ "${actual_runtime}" = "${RUNTIME}" ] \
  || { echo "runtime mismatch: expected ${RUNTIME}, got ${actual_runtime}" >&2; exit 1; }
[ "$(docker inspect "${CONTAINER}" --format '{{.HostConfig.ReadonlyRootfs}}')" = "true" ] \
  || { echo "root filesystem is not read-only" >&2; exit 1; }
[ "$(docker inspect "${CONTAINER}" --format '{{.HostConfig.LogConfig.Type}}')" = "local" ] \
  || { echo "bounded local log driver is not active" >&2; exit 1; }
log_config="$(docker inspect "${CONTAINER}" --format '{{json .HostConfig.LogConfig.Config}}')"
grep -q '"max-size":"10m"' <<<"${log_config}" || { echo "log max-size missing" >&2; exit 1; }
grep -q '"max-file":"3"' <<<"${log_config}" || { echo "log max-file missing" >&2; exit 1; }
tmpfs_json="$(docker inspect "${CONTAINER}" --format '{{json .HostConfig.Tmpfs}}')"
grep -q '"/tmp":' <<<"${tmpfs_json}" || { echo "/tmp tmpfs missing" >&2; exit 1; }
grep -q '"/home/agent":' <<<"${tmpfs_json}" || { echo "/home/agent tmpfs missing" >&2; exit 1; }

docker exec "${CONTAINER}" /bin/bash -euo pipefail -c '
echo "--- read-only root filesystem ---"
! touch /usr/.greenhouse-write-probe 2>/dev/null \
  || { echo "unexpectedly wrote to the root filesystem"; rm -f /usr/.greenhouse-write-probe; exit 1; }
touch /tmp/.greenhouse-write-probe /home/agent/.greenhouse-write-probe

echo "--- versions ---"
for c in git rg jq unzip pdftotext pandoc convert chromium python3 pip fc-list; do
  printf "%-12s %s\n" "$c" "$(command -v "$c" || echo MISSING)"
done

echo "--- python packages ---"
python3 -c "import pandas, docx, pptx, openpyxl, pypdf, PIL, requests, bs4, lxml; print(\"all 9 import ok, pandas\", pandas.__version__)"

echo "--- pip is the baked venv one; system installs remain read-only ---"
[ "$(command -v pip)" = "/opt/venv/bin/pip" ] || { echo "pip is not the venv pip"; exit 1; }
grep -q "index-url" /etc/pip.conf || { echo "/etc/pip.conf has no index-url"; exit 1; }
cat /etc/pip.conf

echo "--- CJK fonts present ---"
fc-list :lang=zh | head -2
[ -n "$(fc-list :lang=zh)" ] || { echo "no CJK font"; exit 1; }

echo "--- Greenhouse brand fonts (Nunito / Nunito Sans) resolve ---"
fc-list | grep -i nunito | head -4
fc-match "Nunito" | grep -qi nunito || { echo "Nunito not resolvable — brand titles would degrade"; exit 1; }
fc-match "Nunito Sans" | grep -qi nunito || { echo "Nunito Sans not resolvable — brand body would degrade"; exit 1; }

echo "--- Nunito actually RENDERS (fontconfig resolution is not enough) ---"
# The lesson that put these here: fontconfig happily resolves a family headless
# chromium then ignores. A VARIABLE Nunito matched fc-match but rendered as the
# default sans — which is why the image ships STATIC instances. Resolution is
# necessary, not sufficient; the real guard renders "Nunito" and asserts the
# pixels differ from the default sans (DejaVu). Identical = face not applied.
cd /tmp
cat > nun.html <<'NUNHTML'
<!doctype html><meta charset=utf-8><body style=margin:0><div style="font-family:Nunito;font-weight:700;font-size:48px">Greenhouse LPH Max Hydroponic Garden</div></body>
NUNHTML
cat > dvf.html <<'DVFHTML'
<!doctype html><meta charset=utf-8><body style=margin:0><div style="font-family:DejaVu Sans;font-weight:700;font-size:48px">Greenhouse LPH Max Hydroponic Garden</div></body>
DVFHTML
html2png nun.html nun.png 900 120 2>/dev/null
html2png dvf.html dvf.png 900 120 2>/dev/null
python3 -c "
from PIL import Image, ImageChops
a = Image.open(\"nun.png\").convert(\"RGB\")
b = Image.open(\"dvf.png\").convert(\"RGB\")
bbox = ImageChops.difference(a, b).getbbox()
assert bbox is not None, \"Nunito renders identically to DejaVu — brand face not applied\"
print(\"Nunito renders distinctly from the default sans; diff bbox\", bbox)
"

echo "--- html2pdf round-trip with Chinese text ---"
cd /tmp
cat > deck.html <<HTML
<!doctype html><html lang="zh"><head><meta charset="utf-8">
<style>@page{size:A4;margin:18mm} body{font-family:system-ui,sans-serif;color:#2B2B2B}
h1{color:#1F6B34}</style></head>
<body><h1>Greenhouse 种植测试报告</h1>
<p>本文用于验证容器内中文渲染与 PDF 导出链路。</p></body></html>
HTML
html2pdf deck.html deck.pdf 2> chromium.err
[ -s deck.pdf ] || { echo "html2pdf produced nothing"; exit 1; }
pdftotext deck.pdf - > deck.txt
# Assert on the pure-CJK runs: those are what a font-less renderer turns into
# tofu, and tofu does not come back out of pdftotext. Do NOT assert on a mixed
# "Greenhouse 种植测试报告" string — pdftotext breaks lines at font-run boundaries,
# so the Latin and CJK halves of one heading legitimately land on separate lines.
grep -q "种植测试报告" deck.txt || { echo "CJK heading lost in the round-trip:"; cat deck.txt; exit 1; }
grep -q "本文用于验证容器内中文渲染与 PDF 导出链路。" deck.txt \
  || { echo "CJK body text lost in the round-trip:"; cat deck.txt; exit 1; }
echo "PDF $(stat -c%s deck.pdf) bytes; CJK text round-tripped intact"

# Chromium logs ~25 dbus/upower ERROR lines per run without --log-level=3, and
# that noise would land in the agent transcript and be paid for in tokens.
err_lines=$(wc -l < chromium.err)
[ "$err_lines" -le 3 ] || { echo "html2pdf is noisy on stderr (${err_lines} lines):"; head -5 chromium.err; exit 1; }
echo "stderr quiet (${err_lines} lines)"

echo "--- html2png at a 16:9 slide size ---"
html2png deck.html shot.png 1600 900
python3 -c "
from PIL import Image
im = Image.open(\"shot.png\")
assert im.size == (1600, 900), im.size
print(\"png\", im.size)
"

echo "--- pandoc markdown -> docx, reread with python-docx ---"
printf "# 标题\n\n正文一段。\n" > note.md
pandoc note.md -o note.docx
python3 -c "
import docx
print(\"docx paragraphs:\", [p.text for p in docx.Document(\"note.docx\").paragraphs][:2])
"

echo "--- runner probe reports what this image really has ---"
node -e "import(\"/opt/runner/dist/toolchain.js\").then(m => process.stdout.write(m.renderToolchainBlock()))"

echo "--- test files must not ship in the image ---"
[ -d /opt/runner/dist/__tests__ ] && { echo "__tests__ leaked into dist"; exit 1; } || echo "dist is clean"
'

cleanup
trap - EXIT
echo "==> smoke test passed for ${TAG}"
docker image inspect "${TAG}" --format 'image size: {{.Size}} bytes'
