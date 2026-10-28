# Real product captures

The website, repository README and introduction film use the real Greenhouse application at
revision `5c7436b3` (3.0 main), captured on 2026-10-26. The workspace database is an isolated
local sandbox containing the fictional `data/examples/` dataset plus fixtures created through
the API by the capture script. These are demonstrations, not customer accounts or endorsements.
Chat answers come from a live configured model; they are not mocked or written into the image.

## Reproduce Web captures

```bash
pnpm run-dev up --fresh --db=greenhouse_wt_site_demo
# Use the isolated database URL reported by run-dev, never a shared/production database:
DATABASE_URL=<isolated-local-database-url> pnpm seed --keep
E2E_BASE_URL=http://localhost:<web-port> node scripts/capture-screens.mjs
```

Requirements: installed workspace dependencies, a real configured model, Playwright Chromium,
`ffmpeg` and `cwebp`. The script logs in as `maya@greenhouse.example` / `greenhouse`, visits the
actual pages, captures WebP files and records a knowledge-answer video. It fails on page errors
or failed API responses. The table capture waits for actual records before taking the image.
Use `--only tables,product-story` for the additional website surfaces without generating new
chat replies. `capture-manifest.json` records the captured routes and times; its lastRun is the
most recent invocation, not a claim that every optional surface ran on that invocation.

`mobile-chat.webp` is **responsive Web**, not the native app. The `ios-*.webp` files are native
iOS Simulator captures, running this checkout's JavaScript through Metro and the matching
Expo 57 / React Native 0.86 development client. They use the same local demonstration server.
Native capture provenance is recorded separately in `native-captures.json`.

## Website preview

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory docs
```

Open http://localhost:4173. The site is plain HTML/CSS with a small inline script for language,
keyboard-accessible tabs and copying deployment commands. No build, CDN or framework runtime
is required. Assets under `../brand/` are copies of the canonical `logos/` assets; Nunito comes
from `packages/ui/src/assets/fonts/`. Screens are never redrawn or generated with AI.

## Introduction film

`docs/video-source/` is the editable HyperFrames project. Its SPEC, narration and source asset
ledger document the shots and sound. The delivered MP4, poster and subtitle tracks live in
`docs/assets/video/`. See [video instructions](../../video-source/README.md) to preview or render.
