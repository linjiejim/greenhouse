# Computer plugin

Per-member E2B Linux sandboxes, command/file operations, transfer, idle cleanup and minute metering.

**Default: off.** Enable `computer` through `extensions.enabled` or `GREENHOUSE_EXTENSIONS` (keep the
other ids), then restart. Credentials alone do not enable it; disabling preserves data.

| Surface | Details |
|---|---|
| Settings | `computer.enabled` (default false), `computer.api_key` (secret), `computer.template`, `computer.domain`, `computer.max_running`; exposed in Runtime config and Services & pricing. |
| Environment | `COMPUTER_ENABLED`, `E2B_API_KEY`, optional `E2B_TEMPLATE`, `E2B_DOMAIN`, `COMPUTER_MAX_RUNNING` (default 5). |
| Owned tables | `member_computers` |
| Tools | `computer_exec`, `computer_files`, `computer_transfer`, `computer_stop` (members' agents over MCP and the Agent API only) |
| Routes | `/api/computer`, `/api/admin/computers` |
| Client | The Computer page (state, this month's minutes and their price, the idle rule, start and stop) and the Admin › Computer section. |

Registers the computer billable service and sweep job; enablement alone does not bypass
credentials, budget or the workspace switch.

Rules: [AGENTS.md](AGENTS.md). Plugin contract: [EXTENDING.md](../../EXTENDING.md).
