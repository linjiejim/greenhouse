# Tables official plugin

- Default on. Preserve `/api/tables`, `#/tables`, the three tool ids, the `tables` feature flag and MCP group, and `tables_record` links. Disabling preserves data and removes contributions. Use `services(db).tables`; never add the service back to DatabaseProvider.

- Nine tables: `0001_adopt.sql` is the plugin baseline (creates them on enable; adopts 3.x tables in place). Base membership remains in core `shares` (`table_base`); record attachments remain in core `file_links` (`table_record`, slot = field id). Register these discriminators and `tables_schema_plan` receipt kinds. Drive nodes retain `scope=tables, base_id=...`; the active scope owns placement validation and Base ACL. No Tables example seed rows existed; future Tables datasets belong in this package.

## Schema plans and authorization

- `tables_query` reads and `tables_mutation` writes records through the same platform actions used by HTTP. Both expose their existing proxy/MCP tiers. Structure changes use the chat-only `tables_schema_plan`, which only drafts an artifact and has no proxy/MCP surface. `interactiveOnly` excludes it from unattended runs.
- Confirmation is the card button, never a model-supplied confirm parameter. The apply endpoint requires the member's Bearer token and dispatches each existing action. Schema changes need builder access; Base settings need owner access. Draft probes prevent unusable plans but grant no permission.
- Apply operations individually and report applied/failed/skipped honestly. Transitively skip operations whose reference failed; do not bypass dispatch to create a cross-action SQL transaction.
- Derive the stable action id from assistant message and pipeline position. Claim the durable receipt before the first operation. Replay returns the stored result; processing/failed receipts must not re-arm the plan. Shared read-only conversations receive no mutation handles.
- Creating a Base also creates its default table; plans must name/reuse it with defaultTableRef/defaultTableName. Every new table already contains the required primary Name field and a Grid view.
- Use the shared isUniqueViolation helper to map nested Drizzle/Postgres conflicts. Preserve the pinned application manifest/hash; deliberate action changes require its version and golden hash to change together.

## Records and lifecycle

- Base/table deletion sets archived_at; record deletion sets deleted_at. Existing read paths filter these states. getRecordById deliberately includes deleted records for recycle-bin/audit use; getRecord does not.
- Base/table archive requires owner access; create/update structure requires builder. Preserve records, fields and relation links on archive. Reject new links to archived tables and stop refreshing their rollups.
- Models cannot archive Bases/tables: schema plans have no archive operation. Keep the tool guidance pointing the member to the sidebar.
- Records have an editor-accessible recycle bin. Base/table recovery stays administrator-only through `pnpm cli tables list-archived | restore-base | restore-table`. Restoring/deleting a record increments revision and refreshes dependent rollups.
- All record reads, queries, aggregates, writes and batches check record.values field policy in requireTableData. Masked single reads return empty values; queries/aggregates require full read to prevent inference.
- Personal views require the current user id at the DB boundary; builder status does not grant another member's personal view. Attachments accept only Drive file ids from the same Base.
- Forms, dashboards, in-table automations and Tables notifications were retired in 3.0. Do not restore them.

## Classic web

- Grid, sidebar, dialogs, API client, catalog, schema-plan card and translations belong here. Cards receive host-derived action/session handles. Explicit submodule titles take precedence over the page-host title.

- InlineEditCell and its multi-select editor remain core shared primitives because other plugin pages already consume the snapshot-locked kit exports. Reuse those primitives; Tables-specific dialogs and grid stay in this package.
