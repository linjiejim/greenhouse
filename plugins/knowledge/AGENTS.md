# Knowledge plugin

- Shared plugin rules: [root AGENTS.md](../../AGENTS.md) (Plugins) and [EXTENDING.md](../../EXTENDING.md); this file lists only Knowledge-specific rules.
- Owns `kb_documents`, `kb_versions`, document/sharing services, `/api/knowledge`, tools, MCP document resources, search, CLI and seeds. Enabled by default. Access services through `services(db)`; DatabaseProvider has no knowledge accessor.
- Preserve every legacy URL, tool id/action, `kb_doc` kind and `greenhouse://knowledge/doc/{slug}` URI. Server Markdown conversion uses the declared @greenhouse/knowledge-editor/markdown dependency.
- The client's Knowledge place is the official native page `knowledge` (apps/client/src/knowledge, src/plugins/knowledge); it vendors the editor schema, so editor schema changes keep the client's editor parity test green.
- Canonical content is Markdown; `{}` is legal Tiptap state. Version history is immutable. Use `api/knowledge/access.ts` for team/owner/share/group ACL and the platform adapter for capabilities/audit on every transport.
- FTS writes and queries use the same shared segmentation. Search scopes may only narrow; an empty folder-id set returns zero rows. Reorder validates siblings and access domains; 0 sorts after manually ordered entries. Export is super-only and includes team-visible documents only.
- Route additions must update the fail-closed HTTP action map and its test. The bare `/export` path retains its super guard.
- `onKnowledgeDocChange` is the only live-update producer. Send ids to everyone who could read before or after an edit; async audience failures never fail the write. Unsubscribe on shutdown.
- `teamContextSources` preserves legacy document selections. Revalidate published/team visibility on every read. Core Markdown context remains available without the plugin. Optional source settings are registered only while active.
- Drive owns files/folders. Register `kb` placement, synchronous/node authorization and folder occupancy through driveScopes; `cabinet: true` keeps the legacy Files cabinet when active. Core falls back to its independent `drive` scope when disabled.
- Compact transcripts and citations are contributed through `toolResults`; never put full document bodies into persisted pipeline summaries. Exact Runtime evidence remains unchanged.
- Sharing goes through `knowledge_mutation` share_doc/unshare_doc and the HTTP share routes; the client's share panel (apps/client/src/knowledge/use-doc-shares.ts) uses the routes.
- `0001_adopt.sql` is the plugin baseline: guarded DDL that creates the tables on enable and adopts 3.x tables in place. Never edit an applied lane file. Register owned tables in resetTables and keep [schema](db-schema.md) current.
- Test the disabled state, ACL parity, source selection and existing tree/export behavior.
