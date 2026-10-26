# 项目插件表结构

事实源：`api/schema.ts`；迁移：`migrations/0001_adopt.sql`（3.0 原地认领）。

### 项目（projects.ts）

| 表 | 主键 / 唯一 | 用途与关键列 |
|---|---|---|
| `projects` | PK `id` | 项目；`status`、`priority`、`owner_id`（逻辑）、`start_date` / `end_date`（date）、`visibility` |
| `project_members` | PK `id`；UK `(project_id, user_id)` | 成员与角色；FK `project_id` CASCADE |
| `tasks` | PK `id` | 任务；`parent_id` 自引用 SET NULL、`status`、`priority`、`assignee_id`（逻辑）、`start_date` / `due_date`（date）、`tags`、`dependencies`（任务 id 数组） |
| `task_comments` | PK `id` | 任务评论；FK `task_id` CASCADE |

项目与任务的动态写在 `audit_events`（`app_id='projects'`）。


外键：project_members.project_id / tasks.project_id → projects.id（CASCADE）；tasks.parent_id → tasks.id（SET NULL）；task_comments.task_id → tasks.id（CASCADE）。

逻辑关联：项目 owner / created_by、成员 user_id / added_by、任务 assignee / created_by、评论 user_id → 核心 users.id；项目动态写核心 audit_events。按项目 → 任务 → 评论删除；停用插件不删数据。
