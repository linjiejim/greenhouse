# Greenhouse · Haven

Haven uses a rounded greenhouse silhouette with an arch cut out of its centre.
The seed in that space suggests an agent growing inside a shared workspace.

## Identity

| Element | Default |
| --- | --- |
| Mark | Forest `#235D4D`; seed `#B6CA68` |
| Interaction accent | `#358566`; semantic text/focus tokens keep contrast |
| Dark mark | Pale green `#D7EFDD`; the seed retains its colour |
| Type | Locally bundled Nunito; system CJK fallback; monospace for code |
| Radius | xs 3, sm 6, md 8, lg 12, xl 16, 2xl 24 px |
| Startup | The two sides close in, then the seed grows; about 1.3 seconds, once |

The seed is an accent, not a text colour. Keep dense tables and navigation compact;
use rounded containers without turning every row into a pill. Status and chart
colours retain their meaning. Plant avatars keep their own established palette.
Mermaid uses the corresponding platform radius token for ordinary rectangular
nodes and sequence participants; diamonds and explicitly shaped nodes keep their
meaning. The mobile diagram WebView embeds Nunito WOFF2 so its font is available
without a separate network request.

Startup never delays a ready application. Route changes do not replay it;
reduced-motion preferences show the final static mark. Desktop satellite windows
skip the intro. Mobile animates the first JS content while auth/fonts initialise;
the operating system's native launch screen remains static.

Web/Bridge share `packages/ui/src/styles/{tokens,fonts,brand}.css`. Web headings and
body use `--font-sans`, so a configured workspace font/logo still takes precedence.
Nunito has no CJK glyphs: Chinese uses the platform's CJK font. Native app content
and navigation use Nunito with their existing dynamic type sizes; OS keyboards,
system menus and other system-owned surfaces use the platform font.

## Sources and exports

- Canonical geometry: `packages/ui/src/assets/greenhouse-mark.svg`.
- React: `@greenhouse/ui/components/brand`; application pages use `AppLogo`.
- Mobile: `src/ui/logo.tsx` consumes the generated geometry copy because mobile
  is a standalone package.
- This directory contains the standalone mark, outlined Nunito wordmark, app
  icon, opaque square iOS icon, inset Android foreground and monochrome template.
- Fonts and SIL Open Font License: `packages/ui/src/assets/fonts/`.

Regenerate all existing client icon sizes and font exports from the repository root:

```sh
python3 scripts/build-brand-assets.py
pnpm exec prettier --write packages/ui/src/components/brand/paths.generated.ts
pnpm exec prettier --ignore-path /dev/null --write apps/mobile/src/ui/brand.generated.ts
pnpm exec prettier --ignore-path /dev/null --write apps/mobile/src/ui/brand-web-font.generated.ts
```

The generator needs Python `fonttools[woff]`, Pillow and `rsvg-convert`. It creates
WOFF2 variable normal/italic faces, native 400/500/600/700 faces, outlined wordmark,
SVG/PNG/ICO/ICNS assets, the mobile WebView font CSS and both renderer geometry files. Do not independently redraw
an exported logo. The website references its generated favicon as the mark.

After website utility edits run `bash scripts/build-landing.sh`. Verify actual UI
with `node scripts/capture-screens.mjs` against the isolated acceptance server;
do not repaint screenshots. Changing desktop/mobile icons or native font plugins
requires a new native build, not only a web/OTA update.

The web design showcase (`#/design`) includes logo sizes, an intro replay button,
the typography scale, radius samples and light/dark colour tokens.

The two animated house contours use the same winding direction, so their overlap stays solid when combined into the static mark (including Android SVG rendering).
