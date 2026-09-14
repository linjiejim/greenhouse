---
name: add-agent-profile
description: >-
  在 greenhouse 里新增或修改 Agent Profile。先回答"该不该新增系统预设"——绝大多数需求
  应该做成 custom Agent（DB 资产）或 profile pack，而不是往 profiles/ 加 YAML。
  确需新增预设时：YAML → profile.ts 常量 → 前端镜像 → agent-profiles.md → 护栏测试，
  五处必须同步。用户说加个 agent、新增 profile、做个新助手、改系统提示词时使用。
---

# 新增 / 修改 Agent Profile

> 规范事实源：[apps/api/src/profiles/AGENTS.md](../../../apps/api/src/profiles/AGENTS.md)
> （目录清单与边界规则）与
> [apps/api/src/profiles/agent-profiles.md](../../../apps/api/src/profiles/agent-profiles.md)
> （架构、工具矩阵、i18n、rich_output、设计决策）。

## 第 0 步（最重要）：先确认你要的不是系统预设

`profiles/` 下**只有 3 个系统 Profile YAML**，且这是刻意的：

| 文件 | 运行面 | 说明 |
| --- | --- | --- |
| `sprouty.yaml` | `/api/chat` | **唯一预设**，也是默认 Agent（`DEFAULT_PROFILE_ID`） |
| `eval-judge.yaml` | `/api/chat` | hidden，交互式质量评估 |
| `desktop.yaml` | `/api/agent` + `/api/mcp` | hidden，agent-runtime 权威 profile |

四个预设曾经并存，本质是"换引擎"被表达成"换助手"；**模型下放成每轮可切之后**
（`POST /api/chat` 的 `model` 字段），它们已被合并。所以先自问：

| 你想要的 | 正确做法 |
| --- | --- |
| 换个模型 | 输入框旁边切模型，**不要**新建 profile |
| 换套提示词 / 收窄工具，给某些人用 | **custom Agent**（DB 资产，见下）——这是常规路径 |
| 一个 fork / 部署专属的角色集 | **profile pack**：`greenhouse.config.ts` 的 `packs.profiles` 指向仓库外目录（pack 可覆盖 core id） |
| 私有模块自带的角色 | 扩展缝，见 [EXTENDING.md](../../../EXTENDING.md) |
| 改现有助手的措辞 / 能力 | 直接改 `sprouty.yaml`（只此一份，无副本可漂移） |
| 真的需要第 4 个内置预设 | 继续往下——并准备好在 AGENTS.md 里登记理由 |

### custom Agent（绝大多数情况的答案）

- 存 `custom_profiles`（身份 / owner / 发布指针）+ `custom_profile_versions`（不可变可执行 manifest）
- 引用形态 `custom:<id>@<version>`；会话、定时任务、Eval 创建时必须先 pin
- `base_profile_id` **只能是预设之一**（`CUSTOM_BASE_PROFILE_IDS = PRESET_PROFILE_IDS = ['sprouty']`）；
  base **只**提供 `access.rich_output` 与 model fallback
- **编辑即撤销原审查**：任何新版本把资产恢复为 `draft`，清空 published/reviewer 并停止共享；
  只有 super 可发布 `pilot` / `verified`
- 工具只能**收窄**（`profile.tools ∩ 用户有效工具`），永远放大不了权限
- 用户面入口：`#/agents`（My Agents）

## 步骤 1：写 YAML（确需新增预设时）

在 `apps/api/src/profiles/` 建 `xxx.yaml`：

```yaml
id: xxx
name: Xxx
version: 'YYYY-MM-DD'
# 面向用户的文案可以是纯字符串，或 { zh, en } 映射（源语言 zh）
description:
  en: …
  zh: …

# ─── Access Control ───────────────────────────────────────
access:
  level: internal     # 只有 internal | hidden 两种
  rich_output: true

# ─── Model Configuration ─────────────────────────────────
# 只写默认模型 id。采样/推理参数属于模型，住 config/models.yaml。
model:
  id: flash

# ─── Tools ────────────────────────────────────────────────
tools:
  - knowledge_query
  - project_query

# ─── System Prompt ────────────────────────────────────────
system_prompt: |
  …
```

硬约束：

- **`access` 只有 `level: internal | hidden` 与 `rich_output`**——没有 `public` / `admin`，
  也不要在 profile 里声明平行权限层（会话要求由具体 runtime/route 决定）
- **YAML 不写 `options`**：`temperature` / `reasoning_effort` 等写
  [config/models.yaml](../../../apps/api/src/config/models.yaml)，由 `resolveModelConfig()` 合并
- **`model.id` 只是起点不是承诺**：模型是每轮的选择，落库进 `messages.model`；
  这个默认值服务的是 headless 路径（定时任务、eval、workflow 节点、子会话）
- **没有 `extends`**——它只为"同一个 Agent、换个模型"而生，已随四预设一并删除
- **`rich_output` 的块格式说明只有一份**：`RICH_OUTPUT_GUIDE`（`packages/utils/src/prompts.ts`），
  由 `enrichSystemPrompt()` 追加，不要在 YAML 里另写
- **提示词不复述动态装配的工具规则**：按用户权限装配的工具（`knowledge_mutation`、`tables_mutation` 等）
  其使用 / 确认 / 展示规则写在工具自身 `description` 里。prompt 只能点名 `is_global: true` 的工具
  或本 profile `tools:` 明确声明的，否则会对未分配用户留下**虚假能力描述**
- `system_prompt` 不做 i18n；`name` / `description` 写错 locale key 或空串会**直接抛错**导致加载失败

## 步骤 2：同步五处（漏一处就坏）

清单有**两个真源**，必须同时改：文件系统（`loadAllProfiles()` 扫目录）与 `profile.ts` 常量。
> 只加 YAML 不进常量 = 一个没人能选到的 Agent；只改常量不加 YAML = 启动即报 `Profile not found`。

1. `apps/api/src/profiles/xxx.yaml` — 新文件
2. [apps/api/src/profiles/profile.ts](../../../apps/api/src/profiles/profile.ts) —
   `PRESET_PROFILE_IDS` 等常量（**顺序即选择器顺序**）
3. [apps/web/src/lib/agent-constants.ts](../../../apps/web/src/lib/agent-constants.ts) —
   前端镜像的预设 id、顺序与 `LEGACY_AGENT_IDS`
4. [apps/api/src/profiles/agent-profiles.md](../../../apps/api/src/profiles/agent-profiles.md) —
   架构图与工具矩阵
5. [tests/api/agent-profiles.test.ts](../../../tests/api/agent-profiles.test.ts) —
   护栏钉住 YAML 数量与文件名集合、旧 id 映射、合法 custom base 集合、rich-output 单一副本、
   "没有 profile 使用 extends"、采样参数归目录

## 步骤 3：工具选择

`tools:` 只引用 `tools/registry.ts` 里已注册的 id。注意：

- **系统 profile 的 `tools:` 在运行时不被读取**（chat / fork / 定时任务同口径）——
  装配由 `resolveEffectiveTools` 按用户权限 ∪ 全局工具算。这个列表主要是**文档与 custom 收窄的基线**
- `is_global: true` 的工具不在列表里也全员可用
- 跑不起来的模型不会出现在选择器里：`GET /api/profiles` 同时返回 `listChatModels()`，
  会过掉没有可达 provider（`api_key_env` 未配）的模型

## 步骤 4：旧 id 只映射、不迁移

退役 id 经 `normalizeProfileId()` 映射到 `sprouty` / `desktop`。会话、eval run、定时任务、
custom base 里存的仍是旧值，读取时解析即可——**不要为这些 id 重建 YAML**。

## 步骤 5：门禁

```bash
pnpm typecheck
pnpm lint
pnpm test
```

验证：`resolveProfileAsync()` 能解析新 profile；前端选择器能看到它（非 hidden 时）。

## 检查清单

- [ ] 先确认过"不该做成 custom Agent / profile pack / 直接改 sprouty"，并登记了新增预设的理由
- [ ] `access` 只有 `level: internal|hidden` + `rich_output`
- [ ] YAML 无 `options`、无 `extends`、无第二份 rich-output 说明
- [ ] prompt 没有复述动态装配工具的规则，没有虚假能力声明
- [ ] `name` / `description` 的 i18n 形态合法
- [ ] 五处已同步：YAML / `profile.ts` / `agent-constants.ts` / `agent-profiles.md` / 护栏测试
- [ ] `tools:` 里的 id 都在 registry 中真实存在
- [ ] typecheck + lint + test 通过
