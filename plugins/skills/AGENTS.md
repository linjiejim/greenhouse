# SkillHub plugin

- Shared plugin rules: [root AGENTS.md](../../AGENTS.md) (Plugins) and [EXTENDING.md](../../EXTENDING.md); this file lists only SkillHub-specific rules.
- Default on. Owns `skills` / `skill_versions`, the typed service bag, `/api/skills`, skill tools, bundle storage/scanning, boot pack sync and MCP `skill-*` prompts. Saved prompts (`prompts`, `/api/prompts`, `task_capture`) remain core.
- The client's `skills` page is a read-only list on phones; in a browser it uploads a folder or files (`POST /api/skills/publish`) and shows version history (apps/client/src/plugins/skills/screen.web.tsx). Its upload limits are a vendored copy of `api/skills/bundle.ts`, checked by the client parity test.
- All publish/download/version/meta/scan authorization lives in `api/skills/center.ts`. HTTP and tools are adapters. Reads are internal; writes owner/super; hard delete and scan decisions super only.
- Bundle validation, canonical hash, 64-file / 1 MiB limits and semver/changelog discipline stay in `api/skills/bundle.ts` and the centre. Versions are immutable.
- Store priority: complete `SKILLS_S3_*`, then kit `resolveStorageS3Config()` under `skills/`, then `data/skills`. Partial dedicated configuration fails plugin boot; never hide it with core fallback. Keep version keys backend-neutral and preserve the separate key validation / no-disk-fallback contract.
- Publish scans synchronously before writes. `downloadSkill` owns quarantine for HTTP, tools, previews and prompts. Missing actor fails closed. Third-party rule-clean bundles still need super review before team use; blocked is sticky.
- First-party trust derives only from repository `skillhub/`, never owner-editable tags. Reserved names are super-only. Metadata updates re-scan atomically; never clear a manual ban by publishing another version.
- Boot sync (`api/skills/boot-seed.ts`) reads repository packs, configured `packs.skills` roots and active plugin `skillPacks`; it is the only pack sync.
- `agentContext.prompts` supplies unchanged `skill-*` names, with download checks on listing and rendering. The core saved-prompt facade preserves existing `prompt-*` access for skills grants; chat grants also reach saved prompts without this plugin.
- Register reset tables and migrations; never add DDL to the core lane.
