#!/usr/bin/env bash
# Rebuild the landing page's compiled Tailwind CSS (docs/tailwind.css).
#
# Run this whenever you change Tailwind utility classes in docs/index.html,
# then commit the regenerated docs/tailwind.css. Static edits (copy, meta tags,
# fonts, images) do NOT need a rebuild.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$ROOT/.landing-tw.css"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

# The @import resolves tailwindcss from the root node_modules (a root devDependency).
cat > "$TMP" <<'CSS'
@import "tailwindcss" source(none);
@source "./docs/index.html";
@theme {
  --font-sans: 'Nunito', ui-sans-serif, system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
  --color-brand-50:#f0f5f2; --color-brand-100:#dae8e0; --color-brand-200:#b1d2bf;
  --color-brand-300:#86b59c; --color-brand-400:#5a9479; --color-brand-500:#3b7a60;
  --color-brand-600:#235d4d; --color-brand-700:#1c4d40; --color-brand-800:#163d33;
  --color-brand-900:#10291f; --color-seed:#b6ca68; --color-canvas:#f6f8f7;
  --color-ink:#1c1c1e; --color-ink-soft:#424944; --color-ink-mut:#555c57; --color-ink-faint:#8a918c;
  --color-edge:#dde3df; --color-edge-strong:#c2cbc5;
}
CSS

( cd "$ROOT" && npx @tailwindcss/cli@^4 -i .landing-tw.css -o "$ROOT/docs/tailwind.css" --minify )
echo "✓ built docs/tailwind.css"
