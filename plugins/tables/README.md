# Tables plugin

Typed multidimensional bases, views, records, relations, formulas/rollups and confirmed schema plans.

**Default: on.** Enable/disable `tables` through `extensions.enabled` or `GREENHOUSE_EXTENSIONS`
(keep the other ids), then restart. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | Member feature `tables` defaults on; base membership and builder/owner permissions still apply. |
| Environment | None. |
| Owned tables | `table_bases`, `table_tables`, `table_fields`, `table_views`, `table_records`, `table_record_links`, `table_field_dependencies`, `table_schema_versions`, `table_recompute_jobs` |
| Tools | `tables_query`, `tables_mutation`, `tables_schema_plan` (chat confirmation card only) |
| Routes | `/api/tables` |
| Client | Grids under Files (records, views and record sheets); structure changes go through chat's schema-plan card. |

CLI `tables list-archived`, `restore-base`, `restore-table`. Shares, file links and Drive placement
use core-owned rows.

Rules: [AGENTS.md](AGENTS.md). Plugin contract: [EXTENDING.md](../../EXTENDING.md).
