# SkillHub plugin

Versioned SKILL.md bundles, security scans, publish/download and MCP skill prompts. Saved prompts remain core.

**Default: on.** Enable/disable `skills` through `extensions.enabled` or `GREENHOUSE_EXTENSIONS`
(keep the other ids), then restart. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | `packs.skills` and active `skillPacks` add boot sync roots; no plugin Runtime Config keys. |
| Environment | Optional `SKILLHUB_DIR`, `SKILLHUB_SEED_OWNER_EMAIL`; storage `SKILLS_S3_ENDPOINT`, `SKILLS_S3_BUCKET`, `SKILLS_S3_ACCESS_KEY_ID`, `SKILLS_S3_SECRET_ACCESS_KEY` (all four required together), optional `SKILLS_S3_REGION`, `SKILLS_S3_PREFIX`, `SKILLS_S3_FORCE_PATH_STYLE`. Otherwise uses data/skills. Optional quarantine webhook uses an enabled WeCom transport (`SKILLS_WECOM_WEBHOOK_URL`), with `PUBLIC_BASE_URL` for links. |
| Owned tables | `skills`, `skill_versions` |
| Tools | `skill_query`, `skill_mutation` |
| Routes | `/api/skills` |
| Client | A read-only skills list; publishing goes through `skill_mutation` or the API. |

Skill versions are immutable; download paths enforce quarantine. The repository ships no skill
packs.

Rules: [AGENTS.md](AGENTS.md). Plugin contract: [EXTENDING.md](../../EXTENDING.md).
