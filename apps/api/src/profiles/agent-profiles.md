# Agent Profiles

当前系统 Profiles 共 2 个：

| ID | Name | Runtime | Visibility | Notes |
| --- | --- | --- | --- | --- |
| `default` | Greenhouse Assistant | Cloud `/api/chat` | public / external | 对外通用助手，基于知识库作答。 |
| `team` | Team Assistant | Cloud `/api/chat` | internal | 内部团队助手；工具由用户权限/分配控制。 |

系统 profile 用 TS 编写（`default.ts` / `team.ts` + 同名 `*.prompt.md`），经 `defineProfile()` 用
`systemProfileSchema` 校验；用户自建 profile 存 DB（见下）。两者字段形状以
`@greenhouse/types/profile-manifest`（zod）为**唯一真相源**——增删可配置字段只改这份 schema。

> 约定：按用户权限动态装配的工具（`knowledge_mutation`、`project_mutation` 等）的使用/确认/展示规则写在工具自身的 `description`（随 function definition 下发），profile prompt 不复述，避免工具未装配时留下死指令。

## 模型切换策略（model.choices）

模型可切换性是 **profile 级策略，由服务端裁决**：

- Profile YAML 的 `model.choices` 声明用户可切换的模型（registry id + label）。
  目前只有 `team` 声明 `flash`（Fast）/`pro`（Deep）；`default` 不声明 → 模型钉死。
- 客户端发送 `model_override`（registry id，如 `pro`）；服务端 `resolveModelChoice()`
  （`packages/agent-core/src/model.ts`）只在 override 命中该 profile 的 choices 时才生效，
  否则**静默落回 profile 默认模型**（也会先把原始模型名反查成 registry id）。
- `GET /api/profiles` 返回每个 profile 的 `model_choices`；前端据此渲染快/慢思考选择器
  （`apps/web/src/lib/model-choice.ts`），无 choices 的 profile 不显示选择器、不发送 override。
- custom profile 的 choices 跟随其 `base_profile_id`（基于 `team` 的可切换，基于 `default` 的钉死）。
- 外部用户只能使用 public profile（无 choices），因此天然无法切换模型，无需额外角色特判。

## Default Profile (`default`)

公开通用助手，仅使用 public 工具：

- `knowledge_query` — 搜索/读取知识库文档（action=`search`/`get`，scope=`team`/`personal`/`shared`）
- `analyze_image` — 图片分析
- `ask_user` — 信息不明确时发起结构化反问

不访问内部团队知识库。

## Team Profile (`team`)

内部团队助手，面向 super/team 用户。

工具清单见 `team.ts`（knowledge_query / analyze_image / external_search / feature_request /
generate_image / project_manager / design_sprouty_avatar）。`design_sprouty_avatar` 是形象 DSL
的 Agent 侧入口：`options` 列出可用颜色/配件/叶型/表情目录与用户自己的 custom profiles，
`apply` 将 zod 校验后的 AvatarConfig 写到调用者**本人**的 custom profile（ownership 由
`getByUserSlug(userId, slug)` 强制）。

### 团队知识库工具

`team` profile 通过统一的 `knowledge_query`（只读）+ `knowledge_mutation`（写，confirm-gated）访问 `knowledge_base`：

- `knowledge_query` — 只读，per-request 工具，需要 internal user（`userId` 在 tool-resolution 注入），匿名/外部用户不装配。
  - `action`：`search` / `get` / `list` / `versions`（`versions` 查文档改动历史，便于 restore 前确认）。
  - `scope=team`：搜索/读取团队文档（`visibility=team`，`status=published`）；非 `team` 一律视为 not found，不会命中任何用户的个人文档。
  - `scope=personal`：搜索/读取**当前用户本人**的个人文档（`visibility=private`，按 `owner_user_id` 隔离）；非本人或非 private 一律视为 not found。
  - `scope=shared`：他人直接或通过分组分享给当前用户的私有文档。
  - 定位：个人知识库即用户的**长期记忆**（可编辑、带版本回溯），用于沉淀业务/项目上下文与偏好，供未来会话回溯。
    Web 端写入走知识库 UI 编辑器；Desktop/CLI Agent 走 confirm-gated `knowledge_mutation`（见下）。

安全边界：

- `knowledge_query` / `knowledge_mutation` 只出现在 internal/team 能力中；`default` public profile 不包含。
- 外部 `/v1/chat` 不应接触 `knowledge_base` 内部文档。
- 各 scope 通过 `visibility`/`owner_user_id` 严格隔离：team 搜索不泄漏个人文档，personal 不返回他人或团队内容。

## Agent Proxy cloud tools（`/api/agent/*` 与 `/api/mcp`）

外部/集成 Agent 通过 `/api/agent/*`（或 `/api/mcp`）调用结构化 cloud tools。无 `profile_id` 时落回内部 `team` profile（解析出绑定用户的全量工具集），再按 proxy allowlist 收窄：

- Read-only cloud tools：`project_query`、`session_query`、`knowledge_query`（`action`：search/get/list/**versions**；`scope`：public/team/personal/**shared**——shared = 别人共享给我的私有文档；回滚前先查版本号）。
- Mutating cloud tools：`project_mutation`、`knowledge_mutation`。`knowledge_mutation` 的 `action`：`knowledge.create_doc` / `knowledge.update_doc` / `knowledge.archive_doc` / `knowledge.restore_version`（按版本号回滚，回滚也记录为新版本）/ `knowledge.share_doc` / `knowledge.unshare_doc`（对个人文档授权给指定用户或 `group:<id>` 小组，`share_role`=reader|editor）。被授予 editor 的人可改/回滚；归档与共享仅 owner。这些工具只通过 mutating proxy allowlist 暴露，每次调用必须带 `confirm:true` 并写入 agent audit。个人 scope 严格限定为当前用户本人文档。

## Custom Profiles（用户自建）

内部用户在 Settings → My Profiles 创建 / Fork。存储为 `custom_profiles` 表：关系列
（`user_id`/`slug`/`name`/`is_shared`/`base_profile_id`/`forked_from`/时间戳）+ 单个 `data` jsonb
（`ProfileData` manifest payload，加字段免迁移）。引用名 `custom:{id}`，`resolveProfileAsync()` 把它
合成出运行时 `AgentProfile`：model / access 继承 `base_profile_id`（`default` 或 `team`）。

可配置字段（`profileManifestSchema` 安全子集，**不含** `access` / 原始 `model` / `apiKey`）：

- 基本：`name`、`description`、`system_prompt`（≤8000，落库前 `sanitizeForPrompt`）、`tools`
  （运行时收窄到用户权限）、`max_steps`、`tool_choice`、`capabilities`、`avatar`。
- 模型：`model_options`（`thinking` / `temperature` / `max_tokens`，合并到 base 的 options）、
  `model_choice_ids`（可切换模型子集，∩ `base.choices`；base 无 choices 则钉死）。
- 行为：`default_language`（解析时追加“回复语言”指令）、`greeting`、`suggested_followups`
  （空态欢迎语 / 建议追问，前端渲染）。

`is_shared`（部署内分享，仅 super 可设）是关系列、不属于 manifest。

## Removed / Legacy IDs

以下旧交互式 profile 不再作为系统 Profile 文件存在：

- `researcher`
- `writer`
- `project-assistant`
- `cs-quality`
- `ops-analyst`
- `cc-analyzer`

（见 `apps/api/src/profile.ts` 的 `LEGACY_TEAM_PROFILE_IDS`。）

兼容规则：

- 旧 preset ID 映射为 `team`，用于历史 session/custom profile 的 model fallback。
- custom profile 的 `base_profile_id` 只能是 `default` 或 `team`。

## Task-specific LLM Configs

task-specific 的系统 prompt（标题生成、记忆抽取等）不是 Agent Profile，位于
`apps/api/src/llm/`，仅由对应的内部流程调用，不出现在 profile picker。
