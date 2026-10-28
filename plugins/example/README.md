# Example notes plugin

Reference SDK 2 data plugin with personal notes, generated CRUD/tools/pages, legacy adapters, context, observations, onInstall and a trusted static UI.

**Default: off.** Compiled by the upstream configuration as a reference. Enable `example` through
`extensions.enabled` or `GREENHOUSE_EXTENSIONS` (keep the other ids), then restart. Disabling
preserves data.

| Surface | Details |
|---|---|
| Settings | `example.greeting`; member feature `example` defaults off, including after enabling the plugin (super bypasses the member flag). |
| Environment | None. |
| Owned tables | `ext_example_notes` |
| Tools | Generated `example_query`, `example_mutation`; compatible `example_notes_query`, `example_notes_mutation` |
| Routes | Generated `/api/ext/example/entities/note`, legacy `/api/ext/example/notes`, public static `/ext/example/ui/` |
| Client | Generated entity pages, an Admin settings form and the embedded `Example UI` page under More. |

CLI `example:count`; note-count job, welcome event and install hook. Build the frontend with
`pnpm plugins:ui:build`. Only the note body is writable; owner and timestamps are server data.

Rules: [AGENTS.md](AGENTS.md). Plugin contract: [EXTENDING.md](../../EXTENDING.md); `api/index.ts`
lists every registered contribution.
