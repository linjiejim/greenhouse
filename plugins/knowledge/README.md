# Knowledge plugin

Markdown knowledge documents, editor, search, versions, sharing and MCP document resources.

**Default: on.** Compiled by the upstream configuration. Enable/disable `knowledge` through
`extensions.enabled` or `GREENHOUSE_EXTENSIONS`, retaining other enabled ids, then restart.
Credentials alone do not enable it. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | Core team-context Markdown works independently; this plugin adds selected-document settings `team_context.conventions` and `team_context.glossary`. |
| Environment | No required plugin-specific env; optional notification integrations use enabled transports. |
| Owned tables | `kb_documents`, `kb_versions` |
| Tools | `knowledge_query`, `knowledge_mutation` |
| Routes | `/api/knowledge` |

Classic `#/knowledge`; universal native Knowledge place. CLI `knowledge`/`kb` imports and reindexes.

See [plugin development](../../EXTENDING.md), [package rules](AGENTS.md) and
`api/index.ts` for registered contributions. Add new SQL after applied migrations; never edit
existing checksums. Test permission denials and disabled contributions as well as enabled behavior.
