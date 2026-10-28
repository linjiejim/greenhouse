# Knowledge plugin

Markdown knowledge documents, editor, search, versions, sharing and MCP document resources.

**Default: on.** Enable/disable `knowledge` through `extensions.enabled` or `GREENHOUSE_EXTENSIONS`
(keep the other ids), then restart. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | Core team-context Markdown works independently; this plugin adds selected-document settings `team_context.conventions` and `team_context.glossary`. |
| Environment | No required plugin-specific env; optional notification integrations use enabled transports. |
| Owned tables | `kb_documents`, `kb_versions` |
| Tools | `knowledge_query`, `knowledge_mutation` |
| Routes | `/api/knowledge` |
| Client | The Knowledge place (team, personal and shared shelves, the document editor). |

CLI `knowledge`/`kb` imports and reindexes. When enabled, Files uses its `kb` cabinet.

Rules: [AGENTS.md](AGENTS.md). Plugin contract: [EXTENDING.md](../../EXTENDING.md).
