# skillhub — official skill packs

The skill packs a Greenhouse deployment ships with. When the API starts it publishes every pack
under `skillhub/<group>/<name>/` as an official team skill (`modules/skills`, `seedOfficial`),
owned by the first active admin and tagged `official` and its group. Until an admin exists it
waits for a later start; a missing directory does nothing.

This checkout ships no packs; the directory documents the format so a deployment can add its
own. Packs are versioned with the repository.

## Skills vs. connectors

Skills and tools are two layers; neither replaces the other.

- **Capability = tools and connectors**: data access, typed calls, permissions. Owned by the
  server, with their own contract in their descriptions and schemas.
- **Knowledge = skills**: playbooks, house style, output formats, assets (templates, scripts).
  A skill has no access of its own; it teaches an Agent how to use what it already has.

A skill must never restate a tool's contract: copies drift the moment the tool changes. Ship a
skill only when it carries something beyond the tools: a multi-step playbook, bundled assets,
or an output specification across tools.

## Pack layout

```
skillhub/
└── <group>/                 # e.g. branding, business, ops
    └── <name>/              # the skill name (lower-case, digits, hyphens; unique)
        ├── SKILL.md         # required: frontmatter (name, description, version) + body
        ├── CHANGELOG.md     # required: a `## <version>` entry for every published version
        ├── references/      # optional: long material the body points to
        └── scripts/         # optional: helper scripts the Agent may run on its computer
```

- SKILL.md's frontmatter: `name` (the folder's name), `description`, `version` (`1.2.0`),
  optionally `tags` and `requirements` (`computer: true`, `connectors: [slug, …]`). A skill with
  requirements runs only for Agents that meet them.
- Publishing is idempotent: a pack whose content matches the latest version is skipped. A
  content change needs a higher `version` and its CHANGELOG.md entry, or the start logs an
  error and keeps the old version.
- Limits: 100 files, 10 MB unpacked, SKILL.md up to 30 000 characters; dotfiles are left out.
- Every pack is scanned (prompt injection, secrets, fetch-and-run commands, binaries, hidden
  characters, suspicious links). Repository content is reviewed with the code, so the findings
  are recorded but never hold an official skill; keep instructions plain and never embed
  credentials.
