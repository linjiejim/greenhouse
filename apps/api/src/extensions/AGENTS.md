# API extensions

- Only index.ts imports extension implementations. Core depends on define.ts, host.ts or extension-kit.ts.
- Routes mount under /api/ext/<id> after member auth; /admin and its children also require admin. Services own authorization for tools/search/panels too.
- Tools and adapter kinds are namespaced. Use existing approval tiers, providers, pinned fetch, usage and budgets.
- Extension SQL is append-only in its own lane; never change core tables or edit an applied migration.
- Declare only working surfaces. Keep contracts under packages/contract/src/extensions without exporting them from core.
