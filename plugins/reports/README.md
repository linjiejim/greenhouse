# Reports plugin

Report templates and branded PDF, DOCX and PPTX rendering into Files.

**Default: off.** Compiled by the upstream configuration. Enable/disable `reports` through
`extensions.enabled` or `GREENHOUSE_EXTENSIONS`, retaining other enabled ids, then restart.
Credentials alone do not enable it. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | No plugin-specific Runtime Config keys; renderers use workspace branding and authorized destination folders. |
| Environment | None required. |
| Owned tables | `report_templates` |
| Tools | `report_templates`, `report_render` |
| Routes | `/api/report-templates` |

Classic `#/skillhub?tab=reports`; universal Reports page. Default templates cover a weekly report and project review. Rendered files remain owned by core Files.

See [plugin development](../../EXTENDING.md), [package rules](AGENTS.md) and
`api/index.ts` for registered contributions. Add new SQL after applied migrations; never edit
existing checksums. Test permission denials and disabled contributions as well as enabled behavior.
