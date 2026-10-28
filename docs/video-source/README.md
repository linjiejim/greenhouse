# Greenhouse introduction film

The 60-second film uses real captures from the isolated 3.0 demo workspace. `SPEC.md` defines
its shots; `scripts/build-product-film.py` holds the authored timing/copy and generates `narration.json`. `assets/` contains local narration and
fonts. The generation script stages screenshots and brand files from `docs/assets/` so there
is only one maintained source for each capture.

```bash
# At the repository root, after the real screenshots have been captured:
python3 scripts/build-product-film.py
cd docs/video-source
npm run check
npx --yes hyperframes@0.8.201 preview --background
npm run render -- --quality delivery --output ../assets/video/greenhouse-overview.mp4
python3 ../../scripts/build-product-film.py --finalize
```

Narration uses the installed macOS `Tingting` voice (`say`) and FFmpeg; keep the resulting WAVs
for rendering on other platforms. No voice clone or paid speech provider is used. The audio
has no music bed. HyperFrames is pinned in package.json for repeatability. This project does
not publish automatically. Final MP4, poster and bilingual WebVTT tracks are in `../assets/video/`.

The builder regenerates `index.html` and scene HTML from its shot definitions. To keep manual
Studio edits, edit the generated project directly and do not run the builder again, or first
carry the changes back into the builder. Only the website loads the delivered MP4; Studio and
its dependencies are not part of the public landing page runtime.
