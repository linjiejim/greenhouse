# Asset library plugin

A team's shared images and videos: upload one or hundreds of files, automatic de-duplication, member descriptions and admin-configured facets, AI titles/descriptions/tags/visible text, full-text search, collections and a bin.

**Default: off.** Enable `assets` through `extensions.enabled` or `GREENHOUSE_EXTENSIONS` (keep the other ids), then restart. Members get it through the `assets` feature (default on once enabled); `assets_manage` (default off, supers always) edits and deletes any asset, merges duplicates, empties the bin and configures facets. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | `assets.ai_enabled` (default on), `assets.ai_language` (`zh` default, or `en`) in Admin › Asset library. |
| Environment | None of its own. AI cataloguing uses the media provider (`MEDIA_*`, `VISION_MODEL`); large files want an object store (COS, or S3 with `STORAGE_S3_PRESIGN=true` so browsers upload directly). |
| Owned tables | `ext_assets_assets`, `ext_assets_uploads`, `ext_assets_collections`, `ext_assets_collection_items`, `ext_assets_facets`, `ext_assets_similar` ([db-schema.md](db-schema.md)) |
| Objects | `assets/<sha256>/original.<ext>`, `thumb.jpg`, `preview.jpg`, `frame-<n>.jpg` in the plugin object store |
| Tools | `assets_query` (search, list, get, collections; read-only), MCP group `assets` |
| Routes | `/api/ext/assets` (uploads, library, collections, facets, duplicates), public static `/ext/assets/ui/` |
| Client | The `Assets` embed under More; links `#/ext/assets/asset/<id>` open it at the asset; global search lane. |

Limits: images up to 100 MB (jpeg, png, webp, gif, avif, heic/heif), videos up to 1 GB (mp4, mov, webm). The browser fingerprints (sha256), previews and keyframes each file; the server re-hashes originals in the background and removes any that do not match. A minute job catalogues new uploads with one metered vision call each, charged to the uploader; a nightly job removes unfinished uploads after 24 hours and empties the bin after 30 days.

Build the frontend with `pnpm plugins:ui:build assets` (an isolated Vite project in `ui-src/`).

Rules: [AGENTS.md](AGENTS.md). Plugin contract: [EXTENDING.md](../../EXTENDING.md).
