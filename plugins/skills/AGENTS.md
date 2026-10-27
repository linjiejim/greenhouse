# SkillHub plugin

- Shared plugin rules: [root AGENTS.md](../../AGENTS.md) (Plugins) and [EXTENDING.md](../../EXTENDING.md); this file lists only SkillHub-specific rules.
- Default on. Owns `skills` / `skill_versions`, the typed service bag, `/api/skills`, skill tools, bundle storage/scanning, boot pack sync and MCP `skill-*` prompts. Saved prompts (`prompts`, `/api/prompts`, `task_capture`) remain core.
- The client shows a read-only skills list (native page `skills`); publishing goes through `skill_mutation` or `/api/skills`.
- All publish/download/version/meta/scan authorization lives in `api/skills/center.ts`. HTTP and tools are adapters. Reads are internal; writes owner/super; hard delete and scan decisions super only.
- Bundle validation, canonical hash, 64-file / 1 MiB limits and semver/changelog discipline stay in `api/skills/bundle.ts` and the centre. Versions are immutable.
- Store defaults to `data/skills`; complete SKILLS_S3_* selects the shared S3 client. Partial configuration fails plugin boot. Do not reuse upload storage: skills have a separate key layout and fallback contract.
- Publish scans synchronously before writes. `downloadSkill` owns quarantine for HTTP, tools, previews and prompts. Missing actor fails closed. Third-party rule-clean bundles still need super review before team use; blocked is sticky.
- First-party trust derives only from repository `skillhub/`, never owner-editable tags. Reserved names are super-only. Metadata updates re-scan atomically; never clear a manual ban by publishing another version.
- Boot sync (`api/skills/boot-seed.ts`) reads repository packs, configured `packs.skills` roots and active plugin `skillPacks`; it is the only pack sync.
- `agentContext.prompts` supplies unchanged `skill-*` names, with download checks on listing and rendering. The core saved-prompt facade preserves existing `prompt-*` access for skills grants; chat grants also reach saved prompts without this plugin.
- Register reset tables and migrations; never add DDL to the core lane.
