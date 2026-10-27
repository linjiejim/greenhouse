# Computer plugin

- Shared plugin rules: [root AGENTS.md](../../AGENTS.md) (Plugins) and [EXTENDING.md](../../EXTENDING.md); this file lists only Computer-specific rules.

## Switch and settings

- Each member gets at most one hosted E2B sandbox; the switch `computer.enabled` resolves DB override → `COMPUTER_ENABLED` → off on every call (`isComputerEnabled()`); admin views show `computerSwitchState()`.
- While the switch is off nothing calls the driver's `create` (`computerUnavailableReason()` runs before any claim), `computer_*` tools are not listed on MCP and calls get the disabled message before any write is recorded.
- The minute sweep (`computer-sweep` job) stops computers still running after the switch goes off.
- `computer.api_key` (secret), `computer.template`, `computer.domain` and `computer.max_running` are workspace settings with `E2B_*`/`COMPUTER_MAX_RUNNING` fallbacks, validated by `settingValidators` and read at call time.

## Lifecycle

- A computer starts on first `computer_exec` or copy-in; reads (`computer_files`, copying out) never start one; idle computers stop after `COMPUTER_IDLE_MINUTES`; members and admins can stop them.
- Stop means kill: files inside are gone; tool descriptions and settings say so and point to `computer_transfer` into Files first. Never imply files survive a stop.
- `member_computers` holds the state and every transition is compare-and-set; when `computer.max_running` computers run workspace-wide, starts are refused explicitly.
- Every create and heartbeat pushes the provider's kill deadline past the operation plus the idle window, so an orphaned sandbox dies on its own.

## Metering blocks

- Billing is service `computer`, provider `e2b`, per minute, through core metering; USD is reserved `COMPUTER_BLOCK_MINUTES` at a time.
- Crossing a block boundary, the sweep reserves the next block first (refused → stop), then settles the finished block in full; a stop settles the open block at whole minutes run (rounded up).
- The row keeps only the current block's reservation key so any process can settle it (`restoreSpendLease`); `blockBudgetKey(computer, blockStart)` gives one admission per block, and retries restore the original reservation.
- Rolling a block is compare-and-set on the current key; a losing process releases its reservation only if the computer never reached that block; a `lost` computer's last reservation stays for the TTL charge.
- Stops claim conditionally: a budget stop only while its block is still current, an idle stop only while `last_used_at` is still before the cutoff; a stale snapshot stops nothing.
- Unknown outcomes keep their reservation for the TTL sweeper (a create that may have reached the provider, an unconfirmed kill marked `lost`); only an explicit provider refusal of `create` releases.

## Tools and driver

- MCP group `computer` stays separate from `services` (arbitrary code with internet access is a different grant); all four tools are `externalOnly` and `openWorld`, never in in-app chat.
- `computer_exec` is a write (≤`COMPUTER_EXEC_MAX_SECONDS`, 200KB per output stream); `computer_files` is a read (list, read ≤1MB); `computer_stop` is a write.
- `computer_transfer` is a write: Files → computer ≤25MB, computer → Files ≤5MB into the personal shelf by default.
- Writes are recorded like every MCP write; long replies use `tool_output_read`.
- `api/e2b/` speaks the control plane over plain HTTP and envd's process and `/files` APIs; command deadlines are enforced inside the computer too (`timeout -k`).
- Sandboxes are created with public inbound traffic off and private ranges denied at the provider edge (`PROVIDER_DENY_OUT`); members can sudo inside, so never pass Greenhouse secrets into a sandbox.
- No desktop, browser, VNC, pause/resume, backups or custom per-Agent computers; persistence across stops would need pause/resume plus storage-cost handling.
- Tests use `setComputerDriverForTests` fakes and never reach E2B.
- Member routes `/api/computer` (status, start, stop); super `/api/admin/computers` lists and stops computers, audited as `stopMemberComputer`.
