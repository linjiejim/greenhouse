# Asset library plugin

- Shared plugin rules: [root AGENTS.md](../../AGENTS.md) (Plugins) and [EXTENDING.md](../../EXTENDING.md); this file lists only asset-library rules.
- One row per sha256 (unique index); objects are content-addressed under `assets/<sha256>/`. Never key an object by row id or file name.
- Browsers write only under `staging/<id>/<generation>/`; `complete` checks sizes with `head()` and copies to the content-addressed keys, which no URL is ever issued for.
- The browser's sha256, dimensions, dHash and previews are claims: the worker re-hashes published originals and invalidates mismatches.
- Removal claims the row (`purging`) before deleting objects; complete, restore, merge and re-upload refuse a purging row.
- Member fields (`title`, `description`, `tags`, `facets`, `source`) and `ai_*` fields stay separate; AI never writes member fields, only `acceptAi` copies them on a member's request.
- Every write that changes a member or AI field goes through the store's `writeFields`/`insertUploading`, which recompute `display_title` and `search_a/b/c`.
- Facet values are stored only when the configured facet offers them (`normalizeFacets`); facet keys are stable, renaming one orphans stored values.
- Every route runs as one action of `platform.ts` via `dispatchAssets`; per-asset rights live in `access.ts` (uploaders edit, `assets_manage` edits/deletes/manages).
- Media URLs come from `pluginObjects('assets').readUrl` (inline only for safe types); downloads go through `downloadAsset` so they are audited.
- Background work is bounded per run and idempotent (claims with `FOR UPDATE SKIP LOCKED`, stale `running` claims taken over after 10 minutes).
- `ui-src/` is an isolated Vite project (own lockfile, `--ignore-workspace`); it talks only to `/api/ext/assets`, `/api/people` and ticket/presigned URLs, and has no `window.confirm` (sandboxed frame).
