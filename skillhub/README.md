# skillhub — first-party skill packs

The source directory and single source of truth for the skill packs a Greenhouse deployment
ships with. On boot the API syncs every pack under `skillhub/<group>/<name>/` into the Skill
Center (`apps/api/src/skills/boot-seed.ts`; a missing directory is a no-op), where members
find, download and install them through the SkillHub page or the `skill_query` tool.

This checkout ships no packs — the directory documents the format so a deployment can add its
own. Packs are versioned with the repository.

## Skills vs. MCP tools

Skills and MCP tools are two orthogonal layers; neither replaces the other.

- **Capability layer = MCP tools** (`/api/mcp`): authentication, typed tools, data access.
  Owned by the server, gated per user and per feature. Tools carry their own contract —
  action lists, parameters, field semantics, limits — in their `description` and schema.
- **Knowledge layer = skills**: playbooks, house style, output formats, assets (templates,
  scripts, fonts). A skill has zero data access of its own; it only teaches an agent how to use
  the tools it already has.

A skill must never restate a tool contract — installed copies drift the moment the tool
changes. Ship a skill only when it carries something beyond what the tools already describe:
a multi-step playbook, bundled assets, or a cross-tool output specification.

## Pack layout

```
skillhub/
└── <group>/                 # e.g. branding, business, ops
    └── <name>/              # the skill id (kebab-case, unique across groups)
        ├── SKILL.md         # required: frontmatter (name, version, description, tags) + body
        ├── CHANGELOG.md     # required: newest entry first, one per published version
        ├── references/      # optional: long-form material the body links to
        └── scripts/         # optional: helper scripts the agent may run
```

- `SKILL.md` frontmatter `version` is the published version; bump it with every content
  change and add a matching `CHANGELOG.md` entry — the sync refuses a content change without a
  version bump.
- Bundles are limited to 64 files / 1 MiB total; text files are stored as UTF-8, everything
  else base64 (`apps/api/src/skills/bundle.ts` is the validator).
- Every pack is scanned for prompt-injection and exfiltration patterns
  (`apps/api/src/skills/scanner.ts`); the guard test asserts zero high findings across the
  directory, so keep instructions plain and never embed credentials.

## Publishing

- **Boot sync** — automatic on every API start (`SKILLHUB_DIR` overrides the location,
  `SKILLHUB_SEED_OWNER_EMAIL` picks the publishing super admin; default is the earliest one).
- **Manual sync** — `node scripts/skillhub-sync.mjs [--dry-run] [--only <name>]` publishes
  through the MCP server using a machine client (`GREENHOUSE_MCP_URL`, `GREENHOUSE_CLIENT_ID`,
  `GREENHOUSE_CLIENT_SECRET`), comparing content hashes so unchanged packs are skipped.
