# Reports 数据表

表归属：`report_templates`；定义在 `api/schema.ts`，访问经插件自身的 services bag。迁移 `migrations/0001_adopt.sql` 保留全部 3.0 列、约束和索引，只认领，不搬数据。停用不删表；显式 `cli plugins drop reports --yes` 才移除。

| 对象 | 键或目标 | 用途 / 规则 |
|---|---|---|
| `report_templates` | PK `id` | 报告模板（report / presentation）；`formats` / `sections` / `cover_fields`、`visibility`、`owner_user_id`（逻辑，null = 内置）、`deleted_at` |
| `report_templates.owner_user_id` | `users.id` | 团队模板比作者长寿 |
