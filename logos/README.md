# Greenhouse · Haven

Haven is a rounded greenhouse silhouette with an arch cut out of its centre; the seed in that
space suggests an agent growing inside a shared workspace.

| Element | Default |
| --- | --- |
| Mark | Forest `#235D4D`; seed `#B6CA68` |
| Dark mark | Pale sage `#B1D2BF` (tokens `brandMark`); the seed keeps its colour |
| Startup | The two sides close in, then the seed grows; once, static with Reduce Motion |

## Files

- `greenhouse-mark.svg` / `.png`: the standalone mark (canonical geometry).
- `greenhouse-logo.svg` / `.png`: mark and outlined Nunito wordmark.
- `greenhouse-app-icon.svg` / `.png`: the rounded app tile (also `apps/web/public/favicon.svg`).
- `greenhouse-mobile-icon.svg`: the opaque square iOS icon; `greenhouse-adaptive-icon.svg`: the
  inset Android foreground; `greenhouse-template.svg`: the monochrome template.

These files, `apps/client/assets/icon.png` / `adaptive-icon.png`, `apps/client/src/ui/brand.generated.ts`
and the web icons are exports of `scripts/build-brand-assets.py` on `main` (geometry source:
`packages/ui/src/assets/greenhouse-mark.svg` there). Copy them over from `main`; never redraw an
exported logo by hand. Changing the app icon needs a new native build, not only an OTA update.
