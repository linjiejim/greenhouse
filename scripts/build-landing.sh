#!/usr/bin/env bash
# Rebuild the landing page's compiled Tailwind CSS (docs/tailwind.css).
#
# Run this whenever you change Tailwind utility classes in docs/index.html,
# then commit the regenerated docs/tailwind.css. Static edits (copy, meta tags,
# fonts, images) do NOT need a rebuild.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$ROOT/apps/web/.landing-tw.css"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

# The @import must resolve tailwindcss from apps/web/node_modules (pnpm layout).
cat > "$TMP" <<'CSS'
@import "tailwindcss" source(none);
@source "../../docs/index.html";
@theme {
  --font-sans: 'Inter', ui-sans-serif, system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
  --color-brand-50:#f0fdfa; --color-brand-100:#ccfbf1; --color-brand-200:#99f6e4;
  --color-brand-300:#5eead4; --color-brand-400:#2dd4bf; --color-brand-500:#14b8a6;
  --color-brand-600:#0d9488; --color-brand-700:#0f766e; --color-brand-800:#115e59;
  --color-brand-900:#134e4a;
  --color-ink:#111827; --color-ink-soft:#374151; --color-ink-mut:#6b7280; --color-ink-faint:#9ca3af;
  --color-edge:#e5e7eb; --color-edge-strong:#d1d5db;
}
CSS

( cd "$ROOT/apps/web" && npx @tailwindcss/cli@^4 -i .landing-tw.css -o "$ROOT/docs/tailwind.css" --minify )
echo "✓ built docs/tailwind.css"
