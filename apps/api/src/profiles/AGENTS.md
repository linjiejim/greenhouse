## Agent Profiles 目录规则

`profiles/` 下共 **3 个系统 Profile YAML**，全部仅供内部团队使用。本文件只写目录清单与边界规则；
架构、工具矩阵、i18n、rich_output、检索口径与设计决策见 [agent-profiles.md](./agent-profiles.md)。

### 清单

**可选预设（1 个）**

| 文件 | 运行面 | 说明 |
| --- | --- | --- |
| `sprouty.yaml` | Cloud `/api/chat` | 唯一预设，也是默认 Agent（`DEFAULT_PROFILE_ID`）。模型只写 `id: flash` 作起点——**每轮可切**，采样参数归模型目录，YAML 不写 `options`。 |

**hidden 系统 Profile（2 个，不进 `GET /api/profiles`、不进选择器）**

| 文件 | 运行面 | 说明 |
| --- | --- | --- |
| `eval-judge.yaml` | Cloud `/api/chat` | 交互式质量评估 Agent（`hidden: true` + `access.level: internal`）；打分由 `eval_message` 工具完成。服务端仍可按 id 解析——评测流程与定时任务要用它。 |
| `desktop.yaml` | `/api/agent` + `/api/mcp` | 权威 agent-runtime profile（`DEFAULT_AGENT_PROFILE_ID` / `MCP_PROFILE_ID`），`access.level: hidden`；不能通过 `/api/chat` 或 `/api/sessions` 使用。id 沿用 `desktop` 是历史命名（曾服务已移除的 Electron Desktop，2026-07 瘦身），改名需迁移存量会话数据。 |

### 重要规则

- **清单有两个真源，必须同步**：文件系统（`loadAllProfiles()` 扫目录）与 `apps/api/src/profiles/profile.ts` 的常量
  （`PRESET_PROFILE_IDS`、`DEFAULT_PROFILE_ID`、`CUSTOM_BASE_PROFILE_IDS`）。
  只加 YAML 不进常量 = 一个没人能选到的 Agent；只改常量不加 YAML = 启动即报 `Profile not found`。
- **custom profile 的 `base_profile_id` 只能是预设之一**（`CUSTOM_BASE_PROFILE_IDS = PRESET_PROFILE_IDS`，
  由 `isValidCustomBaseProfileId()` 强制）。`mission`、`eval-judge`、`desktop` 与所有旧 id 都不是合法 base；
  存量的 `team` 等值先经 `normalizeProfileId()` 归一再校验。base **只**提供 `access.rich_output` 与 model
  fallback——custom agent 自带 `custom_profiles.model_id`，预设换模型不会改掉已 fork 出去的 Agent。
- **custom Agent 是稳定资产 + 不可变版本**：`custom_profiles` 只保存身份、owner 与发布指针；可执行 manifest
  追加到 `custom_profile_versions`。引用形态为 `custom:<id>@<version>`，会话、定时任务与 Eval 创建时必须先 pin；
  `resolveProfileAsync()` 找不到 custom 资产/版本必须明确报错，绝不回落 Sprouty。
- **编辑即撤销原审查**：任何新版本都会把资产恢复为 `draft`，清空 published/reviewer/review-date 并停止共享。
  旧 pinned 引用仍可重放，但不能再被其他用户发现或新选中。只有 super 可发布 `pilot` / `verified`；共享只来自
  这两个状态。owner 可提交 review/撤回/归档，super 可审核、暂停与退役；版本行不得 update/delete。
- **模型是每轮的选择，不是 Agent 的身份**（2026-08-01 起，推翻旧的「一个 Agent = 一个模型」）：
  `POST /api/chat` 的 `model` 字段按 `isChatModelAllowed()` 对 `models.yaml` 的 `chat.selectable` 校验后作
  `modelOverride` 下发，落库进 `messages.model`。**profile YAML 的 `model.id` 只是起点**，不再是承诺——
  quick/deep/K3 曾是同一个助手的三份副本，那是「换引擎」被表达成「换助手」的产物。
- **采样参数属于模型目录，不属于 profile**：`temperature` / `reasoning_effort` 等写 `models.yaml` 的
  `options`，由 `resolveModelConfig()` 合并（profile 显式给的仍然优先）。Kimi 服务端钉死采样参数，
  传别的值硬 400，所以该函数对 kimi 上游**强制剥掉** `temperature`/`top_p`/两个 penalty——
  这条护栏在目录层，任何 profile 都绕不过去。
- **没有 `extends`**：它只为「同一个 Agent、换个模型」而生，模型下放到每轮之后就没有消费者了，
  已随四预设一并删除。想复用提示词请直接改 `sprouty.yaml`（只此一份，无副本可漂移）。

- `access` 只保留 `level: internal | hidden` 与 `rich_output`；会话要求由具体 runtime/route 决定，
  不在 Profile 里声明平行权限层。
- **rich_output 的块格式说明只有一份**：`RICH_OUTPUT_GUIDE`（`packages/utils/src/prompts.ts`），由
  `enrichSystemPrompt()` 追加。不要在任何 YAML 里另写一份。
- **提示词不复述动态装配的工具规则**：`knowledge_mutation`、`tables_mutation` 等按用户权限装配的工具，
  其使用/确认/展示规则写在工具自身 `description` 里（随 function definition 下发）。internal profile 的
  prompt 只能点名 `is_global: true` 的工具或该 profile `tools:` 明确声明的工具，否则会对未分配用户留下虚假能力描述。
- **跑不起来的模型不出现在选择器里**：`GET /api/profiles` 同时返回 `models: listChatModels()`，
  该函数过掉在目录里没有可达 provider（`api_key_env` 未配）的模型——没配 `KIMI_API_KEY` 的部署
  就看不到 K3。预设本身只剩一个，可用性判断因此从 profile 挪到了模型。
- **面向用户的文案可 i18n**（`name`/`description`）：写纯字符串或 `{ zh, en }`
  映射，源语言 `zh`，写错 locale key 或给空串**直接抛错**导致 profile 加载失败。`system_prompt` 不做 i18n。
- **`sprouty-mission` / `sprouty-workflows` 已退役**（2026-08-01）——`workflow_plan` 与 `mission_dispatch`
  都对所有内部会话装配，两个「模式预设」因此没有存在理由；planner 方法论已折进 `workflow_plan` 的
  description（随 function definition 下发，覆盖所有装配面）。mission 部分：mission 由任意会话的 `mission_dispatch` 起草 + Launch 执行。`POST /api/sessions` 不再生成 `channel='mission'` 的会话；存量 mission 会话靠 **channel**（不是 profile）继续走 `/api/missions/runs` 的发送路径，`/api/chat` 对该 id 的 400 守卫再留一个版本。
- **旧 id 只映射、不迁移**（`normalizeProfileId()`）：`team`/`default`/`researcher`/`writer`/`project-assistant`/
  `cs-quality`/`ops-analyst`/`cc-analyzer`/`crm`/`workflow-planner`/`sprouty-agents`/`sprouty-quick`/
  `sprouty-deep`/`sprouty-k3`/`sprouty-workflows`/`sprouty-mission` → `sprouty`；`local-dev`/`local-pi` →
  `desktop`。会话、eval run、定时任务、custom base 里存的仍是旧值，
  读取时解析即可——**不要为这些 id 重建 YAML**。
- 外部 Agent（hermes / MCP 客户端等）访问云端能力走 `/api/agent/*` 结构化 cloud tools。
- 批量评测的 task-specific prompt 放在 `apps/api/src/llm/tasks/`；交互式评估使用 `eval-judge.yaml`。

### 当前 task-specific configs

- `apps/api/src/llm/tasks/batch-eval-judge.ts` — batch eval judge（`task:batch-eval-judge`）。

### 新增或修改 profile 后必须同步

- `apps/api/src/profiles/agent-profiles.md` — 架构与工具矩阵文档。
- `apps/api/src/profiles/profile.ts` — 增删预设时同步 `PRESET_PROFILE_IDS` 等常量（顺序即选择器顺序）。
- `apps/web/src/lib/agent-constants.ts` — 前端镜像的预设 id、顺序与 `LEGACY_AGENT_IDS`。
- `tests/api/agent-profiles.test.ts` — 钉住 YAML 数量与文件名集合、旧 id 映射、合法 custom base 集合、
  rich-output 单一副本、「没有 profile 使用 `extends`」、以及采样参数归目录（含 Kimi 剥离护栏）。
