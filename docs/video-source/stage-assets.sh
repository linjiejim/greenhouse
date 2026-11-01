#!/usr/bin/env bash
# Copy the full-resolution captures this film uses from the last `node scripts/capture-screens.mjs` run.
set -euo pipefail
cd "$(dirname "$0")"
SRC=../../.work/captures
mkdir -p assets/screens
for f in chat-tables-answer tables-grid chat-knowledge-answer knowledge my-agents admin-mcp-access admin-activity plugin-embed; do
  cp "$SRC/$f.png" assets/screens/
done
for f in ios-home ios-chat-chart ios-knowledge-doc-dark; do cp "$SRC/ios/$f.png" assets/screens/; done
echo "staged $(ls assets/screens | wc -l | tr -d ' ') captures"
