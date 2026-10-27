# Feishu 数据表

源代码：`api/schema.ts`；服务：`api/db-service.ts`（`db.extensions.feishu`）。迁移：`migrations/0001_adopt.sql` 是本插件基线：新装在插件启用时建表，从 3.x 升级的库原地认领已有表；停用不删表。

| 表 | 主键 / 唯一 | 用途与关键列 |
|---|---|---|
| `feishu_conversations` | PK `id`；UK `feishu_key` | 飞书对话 ↔ 会话映射；`feishu_key` = thread_id ?? root_id ?? message_id，UK 兼做并发仲裁 |
| `feishu_receipts` | PK `message_id` | 飞书事件去重回执，先写回执再干活 |

| 外键 | 引用 | 删除行为 |
|---|---|---|
| `feishu_conversations.session_id` | `conversations.id` | CASCADE |
| `feishu_conversations.user_id` | `users.id` | CASCADE |

`feishu_receipts` 保留 7 天，由插件 retention hook 调用核心有界清扫。`provider_connections(provider=feishu)` / `login_states` 为核心身份表，不属于本插件。
