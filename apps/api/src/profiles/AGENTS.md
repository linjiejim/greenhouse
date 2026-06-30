## Agent Profiles 目录规则

当前交互式系统 Profiles 只保留 2 个 YAML：

- `default.yaml` — Greenhouse Assistant，公开/外部用户可用。
- `team.yaml` — Team Assistant，内部团队云端 Agent。

### 重要规则

- custom profile 的 `base_profile_id` 只能是 `default` 或 `team`。
- 旧 preset profile ID（`researcher`、`writer`、`project-assistant`、`cs-quality`、`ops-analyst`、`cc-analyzer`，见 `profile.ts` 的 `LEGACY_TEAM_PROFILE_IDS`）只做历史兼容映射到 `team`，不要重新创建 YAML。
- task-specific 的 LLM prompt（标题生成、记忆抽取等）放到 `apps/api/src/llm/`，不放在 Agent Profiles。

新增或修改 profile 后，需要同步更新：

- `apps/api/src/profiles/agent-profiles.md`
- 相关 API/Web 测试
