# SkillHub 插件表结构

事实源：`api/schema.ts`；迁移：`migrations/0001_adopt.sql`（3.0 原地认领）。

| 表 | 主键 / 唯一 | 用途与关键列 |
|---|---|---|
| `skills` | PK `id`；UK `name` | 技能中心；`latest_version`、`download_count`、安全扫描列（`scan_status`、`scanned_at` null = 从没扫过、人工裁定列） |
| `skill_versions` | PK `id`；UK `(skill_id, version)` | 不可变、带内容 hash 的技能版本；FK CASCADE |

外键：skill_versions.skill_id → skills.id（CASCADE）。逻辑关联：skills.owner_user_id、skill_versions.created_by、skills.scan_reviewed_by → 核心 users.id。

版本不可变；扫描结论属于技能并记录 scan_version。scanned_at 为 null 表示未扫描；setScanResult 不改目录 updated_at。停用保留所有行；prompts 表仍在核心。
