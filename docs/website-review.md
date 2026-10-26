# Website and media acceptance — 2026-10-26

Capture base: `5c7436b35ab2bf4f347efd45eb709d18bfd22a60`.
PR base: `origin/main`, `f1780797` (3.0.1 release metadata and agent prompt update).
Implementation branch: `codex/website-refresh`. Local preview; no deployment performed.

## Delivered

- Buildless bilingual website, using canonical Haven branding and Nunito. The old browser
  extension privacy URL is preserved and clearly labelled as an archived policy.
- Concise repository README with complete technical material moved to four linked guides.
- Fresh real Web captures, live-model answers and native iPhone/iPad captures, all using the
  fictional example dataset in an isolated local database. Capture manifests accompany them.
- A 60-second 1920 × 1080 / 30 fps H.264/AAC film with Chinese narration, embedded Chinese and
  English subtitle tracks, matching WebVTT tracks, a poster and editable HyperFrames sources.

## Verified

- `pnpm typecheck` and `pnpm lint`: passed.
- Full real screenshot tour: passed, zero console/API issues. The obsolete More-menu capture
  was removed; tables wait for loaded records; connection guide, reports, files, activity and
  pricing were added. Old optional extension screenshots were removed rather than presented
  as current captures; the tour still supports capturing the example extension when enabled.
- Website: English/Chinese switching and persistence; all 78 translation keys present;
  product tabs and ArrowRight/End keyboard navigation; deployment-command copy; desktop and
  narrow layouts; native device images; actual video playback with a 60-second duration and
  both subtitle tracks. No document-wide horizontal overflow in the narrow-layout check.
- Local documentation target files and media paths checked. GitHub links to newly added guides
  become available after the branch lands; the documents are already available in this checkout.
- Film: final CLI lint/check reports zero findings. Keyframes, scene seams, phone-scale frames
  and an extracted frame from the delivered MP4 reviewed. Audio measures −14.0 LUFS integrated,
  −1.5 dBFS true peak. Audio was measured, not evaluated by listening. See
  [film review](video-source/REVIEW.md).

## Test limitation

The default full `pnpm test` run finished with **4,248 passed, 4 timed out, 1 skipped** across
548 files. The failures were 5-second timeouts in `feishu-bot-history.db.test.ts` and
`migrate-from-1x.db-commit.test.ts`, while capturing screenshots and starting simulators.
A focused rerun passed 27 of 28 tests, with one migration timeout remaining. Running the
migration file alone with `--testTimeout=15000` passed all 23 tests. This is diagnostic evidence;
the default full run is not reported as green. No test thresholds or application behavior were
changed. All tests used a separate temporary test database.

## Pre-PR review

- Scope: static website, documentation, real media and local capture/render tooling; no
  application, database, authentication or CI changes. Low risk; revert the PR to roll back.
- Independent review: P0 0, P1 0, P2 1, fixed. Screenshot provenance now updates only after
  successful WebP conversion, with atomic replacement; missing `cwebp` fails the tour.
  A focused execution check covered missing-tool, successful and partial-failure cases,
  verifying that the delivered files and recorded revisions stay consistent.
- Follow-up independent review: P0 0, P1 0, P2 0. Staged secret scan: passed.
- A fresh full test run after syncing the PR base also encountered 5-second database test
  timeouts. The PR records its final result and CI status; this document does not certify
  the default full test suite as green.

## Reproduce the preview

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory docs
```

Open <http://localhost:4173>. See [capture instructions](assets/screens/README.md) and
[film instructions](video-source/README.md) for assets and rendering.
