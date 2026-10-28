# Email 数据表

源代码：`api/schema.ts`；服务：`api/db-service.ts`（`db.extensions.email`）。迁移：`migrations/0001_adopt.sql` 是本插件基线：新装在插件启用时建表，从 3.x 升级的库原地认领已有表；停用不删表。

| 表 | 主键 / 唯一 | 用途与关键列 |
|---|---|---|
| `email_accounts` | PK `id`；UK `(user_id, email_address)` | 成员自己的 IMAP / SMTP 邮箱；连接配置明文，只有 `password_enc` 加密；`preset` 只是 UI 提示 |

| 外键 | 引用 | 删除行为 |
|---|---|---|
| `email_accounts.user_id` | `users.id` | CASCADE |

发信审计仍使用核心 `audit_events`（`app_id=email`, `action_id=send`），与用户为逻辑关联。共享邮箱由部署环境配置，不是数据行。只有 `password_enc` 加密，连接设置为明文。
