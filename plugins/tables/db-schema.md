# Tables 数据模型

### 表格（tables.ts）

| 表 | 主键 / 唯一 | 用途与关键列 |
|---|---|---|
| `table_bases` | PK `id` | 表格库；`visibility` private / team、`owner_id`、`archived_at`；成员在 `shares`（`resource_type='table_base'`） |
| `table_tables` | PK `id`；UK `(base_id, name)` | 数据表；`position`、`schema_revision`、`archived_at` |
| `table_fields` | PK `id`；UK `(table_id, name)`；部分 UK 主字段 | 字段；`type`（17 种）、`required`、`is_primary`、`config`、`archived_at` |
| `table_field_dependencies` | PK `(field_id, depends_on_field_id)` | 公式 / lookup / rollup 依赖 |
| `table_views` | PK `id` | 视图（grid）；`scope` shared / personal + `owner_id`、`config`、`revision` |
| `table_records` | PK `id` | 记录；`values` / `computed_values` jsonb、`revision`、`deleted_at`（回收站） |
| `table_record_links` | PK `id`；UK `(field_id, source_record_id, target_record_id)` | 关联字段的记录连线 |
| `table_schema_versions` | PK `id`；UK `(table_id, version)` | 表结构快照与变更类型 |
| `table_recompute_jobs` | PK `id`；UK `idempotency_key` | 公式 / 汇总重算任务 |

记录附件在 `file_links`（`target_type='table_record'`，`slot` = 字段 id）。

## 外键

| 引用 | 目标 | 删除策略 |
|---|---|---|
| `table_tables.base_id` | `table_bases.id` | CASCADE |
| `table_fields.table_id` | `table_tables.id` | CASCADE |
| `table_field_dependencies.field_id` / `depends_on_field_id` | `table_fields.id` | CASCADE |
| `table_views.table_id` | `table_tables.id` | CASCADE |
| `table_records.table_id` | `table_tables.id` | CASCADE |
| `table_record_links.field_id` | `table_fields.id` | CASCADE |
| `table_record_links.source_record_id` / `target_record_id` | `table_records.id` | CASCADE |
| `table_schema_versions.table_id` | `table_tables.id` | CASCADE |
| `table_recompute_jobs.table_id` | `table_tables.id` | CASCADE |
| `table_recompute_jobs.field_id` | `table_fields.id` | CASCADE |
| `table_recompute_jobs.record_id` | `table_records.id` | CASCADE |
| `table_bases.owner_id`、`table_views.owner_id` | `users.id` | 表格库主人、个人视图主人 |

`shares`（table_base）、`file_links`（table_record）、`folders` / `files`（tables scope）仍是核心治理表，由本插件登记业务判别值与权限规则。
