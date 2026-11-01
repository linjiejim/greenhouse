# Product captures

Images and the hero recording used by the README and the website. All come from a real instance on the
demo dataset with a real model; never mock or hand-edit them.

## Web

1. Fresh database: `pnpm db:migrate` then `pnpm seed`, with `GREENHOUSE_EXTENSIONS=knowledge,tables,skills,feedback,memory,projects,reports,email,computer,retro,example`.
2. `pnpm app:build`, then start the API (it serves the client at `/`) with a working LLM in `.env` or Runtime Config.
3. `CAPTURE_BASE_URL=http://localhost:<port> node scripts/capture-screens.mjs` (needs `cwebp` and `ffmpeg`).

Seed the database before the API starts: role memberships are synced at boot. The script adds the
Customer Feedback base, skills, a custom agent, an MCP machine client and Drive files, asks two questions,
runs the standup automation once, and prints any failed request or console error per step.

## iPhone

Simulator screenshots (`ios-*.webp`) of a Release build signed in as `maya@greenhouse.example` on the same
instance, status bar fixed with `xcrun simctl status_bar <device> override --time 9:41`. Save with
`xcrun simctl io <device> screenshot`, then `cwebp -q 86 -resize 603 0`.
