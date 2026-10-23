#!/usr/bin/env bash
# Rebuild the CJK font subsets the report renderer embeds in PDFs
# (apps/api/assets/fonts/NotoSansSC-{Regular,Bold}.subset.ttf).
#
# Source: Noto Sans SC (SIL Open Font License 1.1, redistribution allowed; the
# licence text ships next to the subsets as OFL.txt). The static TTFs come from
# Google Fonts via the @expo-google-fonts/noto-sans-sc npm tarball; the full
# files are ~10 MB per weight, so we keep only:
#   - every GB2312 character (6,763 hanzi + the GB2312 symbol rows), which
#     covers ~99.7% of modern Simplified Chinese text;
#   - ASCII, Latin-1, general punctuation, CJK symbols, full-width forms,
#     arrows, basic math, bullets/geometric shapes, dingbats, currency, enclosed numbers.
# Characters outside the subset render as blanks; the renderer reports them
# as a warning so an agent (or a person) can see it happened.
#
# Needs: npm, python3 with fontTools (`pip install fonttools`).
# Usage: scripts/build-report-fonts.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/apps/api/assets/fonts"
SRC="$(mktemp -d /tmp/notosc-src-XXXXXX)"
WORK="$(mktemp -d /tmp/notosc-work-XXXXXX)"
trap 'rm -rf "${SRC}" "${WORK}"' EXIT

(cd "${SRC}" && npm pack --silent @expo-google-fonts/noto-sans-sc@0.4.4 >/dev/null && tar -xzf ./*.tgz)

python3 -I - "${WORK}/chars.txt" <<'PY'
import sys
chars = set()
for hi in range(0xA1, 0xF8):
    for lo in range(0xA1, 0xFF):
        try:
            chars.add(bytes([hi, lo]).decode('gb2312'))
        except UnicodeDecodeError:
            pass
ranges = [
    (0x20, 0x7E), (0xA0, 0xFF), (0x2000, 0x206F), (0x20A0, 0x20CF), (0x2100, 0x218F),
    (0x2190, 0x21FF), (0x2200, 0x22FF), (0x2460, 0x24FF), (0x2500, 0x25FF), (0x2600, 0x26FF), (0x2700, 0x27BF),
    (0x3000, 0x303F), (0xFF00, 0xFFEF),
]
for lo, hi in ranges:
    chars.update(chr(c) for c in range(lo, hi + 1))
with open(sys.argv[1], 'w', encoding='utf-8') as f:
    f.write(''.join(sorted(chars)))
print(f'{len(chars)} characters')
PY

for weight in Regular Bold; do
  case "${weight}" in Regular) dir=400Regular ;; Bold) dir=700Bold ;; esac
  pyftsubset "${SRC}/package/${dir}/NotoSansSC_${dir}.ttf" \
    --text-file="${WORK}/chars.txt" \
    --layout-features='kern,liga,locl,vert,vrt2' \
    --no-hinting --desubroutinize \
    --name-IDs='*' --name-legacy --name-languages='*' \
    --output-file="${OUT}/NotoSansSC-${weight}.subset.ttf"
done
ls -la "${OUT}"
