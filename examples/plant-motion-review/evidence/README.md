# Browser evidence

These captures contain only the standalone local preview, no Library file content or account data.

- `v2-expression-matrix.png`: evidence-only static 16 × 8 sheet rendered in Chromium; the interactive product does not run 128 animations.
- `mobile-sunflower.png`: Chromium at a 390 × 844 CSS-pixel viewport; not a physical iPhone.
- `interruptions.gif`: actual Chromium screenshots of sleep → speaking, thinking → done, and rapid interruption. Captured at variable screenshot intervals and encoded at 10 fps; not an FPS measurement.
- `browser-report.json`: assertions and draw-cost measurements from the local harness. Background visibility was a synthetic lifecycle event. No actual OS app switching or Safari/device testing was performed.

Regenerate screenshots and the report with `pnpm test:plant-motion:browser`. Raw results default to `/tmp/greenhouse-motion-qa`. The GIF is a short manually selected review sequence, not an automated golden image.
