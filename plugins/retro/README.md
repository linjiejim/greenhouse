# Monthly retro plugin

Monthly aggregate report written to Knowledge, with optional model suggestions and manual administrative generation.

**Default: off.** Enable `retro` (and `knowledge`) through `extensions.enabled` or
`GREENHOUSE_EXTENSIONS` (keep the other ids), then restart. Disabling keeps generated documents.

| Surface | Details |
|---|---|
| Settings | Depends on `knowledge`. Uses core `team_context.timezone` (default Asia/Shanghai) and model/budget configuration. |
| Environment | No plugin-specific env; core LLM settings are optional for suggestions. |
| Owned tables | None; generated documents/versions belong to Knowledge |
| Tools | None |
| Routes | `/api/admin/retro` (super-only) |
| Client | The Admin › Retro section (generate a month on demand). |

Schedules at 09:00 on the first after prior-month UTC close protection; reuses one document per
month. No model or budget skips suggestions without losing the aggregate report.

Rules: [AGENTS.md](AGENTS.md). Plugin contract: [EXTENDING.md](../../EXTENDING.md).
