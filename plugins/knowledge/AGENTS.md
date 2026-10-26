# Knowledge plugin

- Owns `kb_documents`, `kb_versions`, document/sharing services, `/api/knowledge`, tools, MCP document resources, search, CLI, seeds and classic UI. Enabled by default. Access services through `services(db)`; DatabaseProvider has no knowledge accessor.
- Preserve every legacy URL, tool id/action, `kb_doc` kind and `greenhouse://knowledge/doc/{slug}` URI. Import host capabilities only through the kits; server Markdown conversion uses its declared @greenhouse/knowledge-editor/markdown dependency; browser primitives use the web editor host kit.
- Canonical content is Markdown; `{}` is legal Tiptap state. Version history is immutable. Use `api/knowledge/access.ts` for team/owner/share/group ACL and the platform adapter for capabilities/audit on every transport.
- FTS writes and queries use the same shared segmentation. Search scopes may only narrow; an empty folder-id set returns zero rows. Reorder validates siblings and access domains; 0 sorts after manually ordered entries. Export is super-only and includes team-visible documents only.
- Route additions must update the fail-closed HTTP action map and its test. The bare `/export` path retains its super guard.
- `onKnowledgeDocChange` is the only live-update producer. Send ids to everyone who could read before or after an edit; async audience failures never fail the write. Unsubscribe on shutdown. Classic `wsEvents`/`onReconnect` invalidate the plugin store.
- `teamContextSources` preserves legacy document selections. Revalidate published/team visibility on every read. Core Markdown context remains available without the plugin. Optional source settings are registered only while active.
- Drive owns files/folders. Register `kb` placement, synchronous/node authorization and folder occupancy through driveScopes; `cabinet: true` keeps the legacy Files cabinet when active. Core falls back to its independent `drive` scope when disabled.
- Compact transcripts and citations are contributed through `toolResults`; never put full document bodies into persisted pipeline summaries. Exact Runtime evidence remains unchanged.
- Adoption SQL copies baseline DDL with guarded constraints/indexes. Never edit an applied lane file. Register owned tables in resetTables and keep [schema](db-schema.md) current.
- Test the disabled state, ACL parity, source selection and existing tree/export behavior. Browser specs live in e2e and import only @playwright/test.
