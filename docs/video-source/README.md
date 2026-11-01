# Greenhouse 4.0 film

A 45-second, silent HyperFrames film (it autoplays muted on the website) built only from real 4.0 captures.
`STORYLINES.md` holds the three storylines, `SPEC.md` the numbers, `REVIEW.md` the last review.
Titles are root variables; `variables.zh.json` holds the Chinese copy.

```bash
node ../../scripts/capture-screens.mjs   # from the repository root, against a seeded instance
./stage-assets.sh                         # copies the full-resolution captures into assets/screens
npx --yes hyperframes@0.8.226 check
npx --yes hyperframes@0.8.226 render -o renders/greenhouse-4.0-en.mp4 --crf 22 .
npx --yes hyperframes@0.8.226 render -o renders/greenhouse-4.0-zh.mp4 --crf 22 --variables-file variables.zh.json .
```

Copy the two renders to `docs/assets/video/` and refresh the posters (a frame at 4.6 s, `cwebp -q 84 -resize 1600 0`).
The iPhone frames come from the simulator; see `docs/assets/screens/README.md`.
