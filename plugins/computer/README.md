# Computer plugin

Per-member E2B Linux sandboxes, command/file operations, transfer, idle cleanup and minute metering.

**Default: off.** Compiled by the upstream configuration. Enable/disable `computer` through
`extensions.enabled` or `GREENHOUSE_EXTENSIONS`, retaining other enabled ids, then restart.
Credentials alone do not enable it. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | `computer.enabled` (default false), `computer.api_key` (secret), `computer.template`, `computer.domain`, `computer.max_running`; exposed in Runtime Config/Services & pricing. |
| Environment | `COMPUTER_ENABLED`, `E2B_API_KEY`, optional `E2B_TEMPLATE`, `E2B_DOMAIN`, `COMPUTER_MAX_RUNNING` (default 5). |
| Owned tables | `member_computers` |
| Tools | `computer_exec`, `computer_files`, `computer_transfer`, `computer_stop` (external-agent tools) |
| Routes | `/api/computer`, `/api/admin/computers` |

Classic `#/settings/computer`; universal Computer page. Registers the computer billable service and sweep job; enablement alone does not bypass credentials, budget or workspace switch.

See [plugin development](../../EXTENDING.md), [package rules](AGENTS.md) and
`api/index.ts` for registered contributions. Add new SQL after applied migrations; never edit
existing checksums. Test permission denials and disabled contributions as well as enabled behavior.
