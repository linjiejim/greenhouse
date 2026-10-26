# Example notes plugin

Reference SDK 2 data plugin with personal notes, generated CRUD/tools/pages, legacy adapters, context, observations, onInstall and a trusted static UI.

**Default: off.** Compiled by the upstream configuration. Enable/disable `example` through
`extensions.enabled` or `GREENHOUSE_EXTENSIONS`, retaining other enabled ids, then restart.
Credentials alone do not enable it. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | `example.greeting`; member feature `example` defaults off, including after enabling the plugin (super bypasses the member flag). |
| Environment | None. |
| Owned tables | `ext_example_notes` (reference table, separate from the original 73) |
| Tools | Generated `example_query`, `example_mutation`; compatible `example_notes_query`, `example_notes_mutation` |
| Routes | Generated `/api/ext/example/entities/note`, legacy `/api/ext/example/notes`, public static `/ext/example/ui/` |

Classic legacy `#/example/notes` plus generated `#/ext/example/note`, settings and embed pages; portable entity/settings/embed surfaces. CLI `example:count`; note-count job, welcome event and install hook. Build frontend with `pnpm plugins:ui:build`. Only body is writable; owner/timestamp are server data.

See [plugin development](../../EXTENDING.md), [package rules](AGENTS.md) and
`api/index.ts` for registered contributions. Add new SQL after applied migrations; never edit
existing checksums. Test permission denials and disabled contributions as well as enabled behavior.
