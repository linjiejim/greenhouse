# Greenhouse plant motion review

An isolated, mobile-first comparison of the accepted **A flat-refinement motion V1** and experimental **V2**. This is a review surface, not a replacement for `packages/ui` and not a production deployment.

```sh
pnpm install --frozen-lockfile
pnpm plant-motion:dev
# Open http://127.0.0.1:4173
pnpm typecheck:plant-motion
pnpm test:plant-motion
pnpm exec playwright install --only-shell chromium
pnpm test:plant-motion:browser
# Optional system Chromium: CHROMIUM_PATH=/usr/bin/chromium pnpm test:plant-motion:browser
```

The server binds to loopback only. No account, external service, assets, credentials, or network requests are needed. Opening `v1.html` directly also works offline; the comparison uses ES modules and needs the local server.

## Review flow

Choose V1, V2, or a paired comparison. Change all 16 characters together, or open one character for a large preview and eight static expression samples. Detail controls include previous/next, per-character state, pause/resume, speed, and the same version switch. The main gallery also provides background, seven palettes, 16/20/32/44 px sizes, and a continuous demo.

Three scenarios make timing differences easy to inspect: sleep → speaking, thinking → done, and rapid hello → thinking → speaking → error → done → sleep. Choosing a newer state cancels the scenario. A completion never occurs unless the caller explicitly requests `done`.

## Frozen V1 and shared geometry

`v1.html` is the exact accepted standalone preview, SHA-256:

```
7e287235630086b8db2fd53c8c3021a8f8d277e1cc424414f82b66201eda7005
```

`v1/{catalogue,geometry,motion}.js` are unmodified copies of that preview's source modules. Their A silhouettes were refined from the parent-reviewed visual specification; this executor did not directly read the original Library reference image. The accepted preview is the authoritative V1 baseline for this experiment. The original catalogue ancestry is `633c153a3d20fa148be3074a378564819881dfb6` in `linjiejim/greenhouse`.

V2 imports the same catalogue, palettes, SVG scaffold, LOD, and fit data. It changes existing layer transforms and face paths only; it does not add leaves, pots, limbs, accessories, or new silhouettes. The production renderer, shared types, and application routes are untouched. Keeping the two motion implementations here is an explicitly requested comparison, not a second production source of truth.

## Motion decisions

`v2/controller.js` is a DOM-free controller. Each instance owns one current state, revision, active clock, position and velocity. An exact critically damped spring retargets from both current values and velocities. There are no queued animation completions that can restore an obsolete state. Repeated requests for the current state do not restart it. Only the explicit review demo has a sequence; manual state changes cancel it synchronously.

Gaze gets a short head start. Waking opens the eyes before speech begins; talking uses short, separated phrases. Hello, done, and error are finite gestures that settle. Idle has one small 1.6-second breath in each much longer individual cycle, with most of a 20-second observation completely still apart from occasional blinks. No speaking brows point down. Error is a gentle acknowledgment.

| Character | V2 timing / gesture |
| --- | --- |
| 新芽 | Gaze contact precedes the three existing top leaves; center and side leaves settle differently. |
| 常春藤 | The existing tendril follows the curious gaze, then holds. |
| 鼠尾草 | A restrained inward settling gesture on error. |
| 罗勒 | A small stretch at the beginning of a phrase, with quiet gaps. |
| 蕨 | The intact curl leans slightly; it never unrolls. |
| 紫色三叶草 | Small grouped leaf response, then a quiet release. |
| 龟背竹 | A modest upright lift on completion. |
| 银杏 | A shallow side greeting, without fan folding. |
| 枫 | Prompt gaze/body response with a short stem follow-through. |
| 石莲花 | Inner/outer petal expansion with a fixed, nonrotating center. |
| 仙人掌 | A delayed nod; the side pads stay restrained. |
| 莲 | Slow petal closure, keeping the face exposed. |
| 尤加利 | Existing round leaves respond successively along the branch. |
| 薰衣草 | Stable stem; flower spike nods near phrase end. |
| 向日葵 | A small flower-head lift, retaining cream face features. |
| 蒲公英 | Slight downward settling and tiny seed-cluster lag; no dispersal. |

The renderer uses a shared rAF loop and intersection visibility. Hidden versions and the gallery behind a detail dialog are suspended; eight-state samples and small-size samples are static. Pause stops active time. Document visibility stops the loop and resets the timestamp to avoid background catch-up. Reduced-motion switches immediately to a readable static expression.

## Validation

`controller.test.ts` covers the frozen V1 hash, all 16 × 8 transform bounds, retargeted velocity, newest-revision precedence, repeat clicks, explicit completion, waking, rapid interruptions, 20-second idle quiet time, pause/reduced motion, and frame-rate consistency. It runs in the normal root unit project as well as `test:plant-motion`.

`browser-qa.mjs` starts its own ephemeral local server and drives Chromium. It checks both versions across 16 × 8 states, stable SVG/path identity, clipping, contrast, no duplicate IDs, pause/resume, newest-state precedence, reduced motion, 390px layout, all sixteen detail views, demo, visibility handling, and draw costs. Screenshots and a JSON report go to `/tmp/greenhouse-motion-qa` or `MOTION_QA_OUTPUT`. The dedicated PR workflow runs these checks and uploads evidence. A few reviewed captures are retained in `evidence/`.

The browser test's background lifecycle event is synthetic: headless tabs do not reproduce OS backgrounding. Physical iPhone, Android, Safari, actual app switching, and device battery/thermal performance have not been tested. Draw-time figures are this executor's Chromium measurements, not phone benchmarks.

### Recorded local result (2026-10-13)

- Chromium 154.0.8037.57: both versions × 16 characters × 8 states; no SVG viewport overflow, path replacement, or browser exceptions. Base-palette face contrast minimum 4.92:1. See [browser report](evidence/browser-report.json) for the measured draw-time P95 and individual assertions; the draw budget measures renderer work, not total frame latency.
- Reviewed [128-expression sheet](evidence/v2-expression-matrix.png), [390px detail](evidence/mobile-sunflower.png), and [interruption sequence](evidence/interruptions.gif). The GIF is a sequence of real browser screenshots sampled and encoded at 10 fps; it illustrates the gestures and is not frame-pacing evidence.
- `pnpm lint`, `pnpm typecheck`, `pnpm typecheck:plant-motion`, and 41 dedicated controller tests passed.
- Full `pnpm test` against isolated local `greenhouse_test_motion`: **666 files passed, 5 skipped; 5,721 tests passed, 119 skipped**. Existing browser-dependent suites skipped because the environment denied the Playwright browser CDN (`403 Domain forbidden`); other optional/live suites also use existing skip conditions. The independent preview browser tests ran against the installed system Chromium. The PR CI installs its own browser and runs the unchanged full suite.
