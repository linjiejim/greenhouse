# Monthly retro plugin

Monthly aggregate report written to Knowledge, with optional model suggestions and manual administrative generation.

**Default: off.** Compiled by the upstream configuration. Enable/disable `retro` through
`extensions.enabled` or `GREENHOUSE_EXTENSIONS`, retaining other enabled ids, then restart.
Credentials alone do not enable it. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | Depends on `knowledge`. Uses core `team_context.timezone` (default Asia/Shanghai) and model/budget configuration. |
| Environment | No plugin-specific env; core LLM settings are optional for suggestions. |
| Owned tables | None; generated documents/versions belong to Knowledge |
| Tools | None |
| Routes | `/api/admin/retro` (super-only) |

Classic `#/administration/retro`; universal Retro page/fallback. Schedules at 09:00 on the first after prior-month UTC close protection; reuses one document per month. No model/budget skips suggestions without losing the aggregate report.

See [plugin development](../../EXTENDING.md), [package rules](AGENTS.md) and
`api/index.ts` for registered contributions. Add new SQL after applied migrations; never edit
existing checksums. Test permission denials and disabled contributions as well as enabled behavior.
