# Reports plugin

Report templates and branded PDF, DOCX and PPTX rendering into Files.

**Default: off.** Enable `reports` through `extensions.enabled` or `GREENHOUSE_EXTENSIONS` (keep the
other ids), then restart. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | No plugin-specific Runtime Config keys; renderers use workspace branding and authorized destination folders. |
| Environment | None required. |
| Owned tables | `report_templates` |
| Tools | `report_templates`, `report_render` |
| Routes | `/api/report-templates` |
| Client | A read-only template list; templates are edited through the API. |

Default templates cover a weekly report and a project review. Rendered files remain owned by core
Files.

Rules: [AGENTS.md](AGENTS.md). Plugin contract: [EXTENDING.md](../../EXTENDING.md).
