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
  --font-sans: 'Nunito', 'PingFang SC', ui-sans-serif, system-ui, sans-serif;
  --radius-sm: .375rem; --radius-md: .5rem; --radius-lg: .75rem;
  --radius-xl: 1rem; --radius-2xl: 1.5rem; --radius-3xl: 2rem;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
  --color-brand-50:#f4f7f0; --color-brand-100:#eaf2e8; --color-brand-200:#d4e5d8;
  --color-brand-300:#b1d2bf; --color-brand-400:#74ac91; --color-brand-500:#358566;
  --color-brand-600:#2a6e56; --color-brand-700:#235d4d; --color-brand-800:#194636;
  --color-brand-900:#123427;
  --color-ink:#111827; --color-ink-soft:#374151; --color-ink-mut:#6b7280; --color-ink-faint:#9ca3af;
  --color-edge:#e5e7eb; --color-edge-strong:#d1d5db;
}
CSS

( cd "$ROOT/apps/web" && npx @tailwindcss/cli@^4 -i .landing-tw.css -o "$ROOT/docs/tailwind.css" --minify )
echo "✓ built docs/tailwind.css"
