# Tables plugin

Typed multidimensional bases, views, records, relations, formulas/rollups and confirmed schema plans.

**Default: on.** Compiled by the upstream configuration. Enable/disable `tables` through
`extensions.enabled` or `GREENHOUSE_EXTENSIONS`, retaining other enabled ids, then restart.
Credentials alone do not enable it. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | Member feature `tables` defaults on; base membership and builder/owner permissions still apply. |
| Environment | None. |
| Owned tables | `table_bases`, `table_tables`, `table_fields`, `table_views`, `table_records`, `table_record_links`, `table_field_dependencies`, `table_schema_versions`, `table_recompute_jobs` |
| Tools | `tables_query`, `tables_mutation`, `tables_schema_plan` (chat confirmation card only) |
| Routes | `/api/tables` |

Classic `#/tables`; universal native Tables place. CLI `tables list-archived`, `restore-base`, `restore-table`. Shares/file links/Drive placement use core-owned rows.

See [plugin development](../../EXTENDING.md), [package rules](AGENTS.md) and
`api/index.ts` for registered contributions. Add new SQL after applied migrations; never edit
existing checksums. Test permission denials and disabled contributions as well as enabled behavior.
