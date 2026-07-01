## Agent Profiles 目录规则

系统 Profiles 用 TS 编写（不再是 YAML），由 `defineProfile()` 校验后静态注册：

- `default.ts` (+ `default.prompt.md`) — Greenhouse Assistant，公开/外部用户可用。
- `team.ts` (+ `team.prompt.md`) — Team Assistant，内部团队云端 Agent。

写法：结构化配置写在 `*.ts`（`defineProfile({...})`，对齐 `tools/define.ts` 的 `defineTool`），长 system prompt 放同名 `*.prompt.md`（逐字、免转义，`readPrompt()` 读入）。`defineProfile` 用 `systemProfileSchema`（`@greenhouse/types/profile-manifest`）校验 —— **profile 的字段形状以该 schema 为唯一真相源**。

### 重要规则

- profile 字段的增删一律改 `@greenhouse/types/profile-manifest`，不要在多处手写校验/类型。
- custom profile（用户自建）的 `base_profile_id` 只能是 `default` 或 `team`；其可配置字段是 `profileManifestSchema` 的安全子集（不含 `access` / 原始 `model` / `apiKey`）。
- 旧 preset profile ID（`researcher`、`writer`、`project-assistant`、`cs-quality`、`ops-analyst`、`cc-analyzer`，见 `profile.ts` 的 `LEGACY_TEAM_PROFILE_IDS`）只做历史兼容映射到 `team`，不要重建。
- task-specific 的 LLM prompt（标题生成、记忆抽取等）放到 `apps/api/src/llm/`，不放在 Agent Profiles。

新增或修改 profile 后，需要同步更新：

- `apps/api/src/profiles/agent-profiles.md`
- 相关 API/Web 测试
