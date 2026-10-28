# Memory plugin

Personal long-term memory, pinned notes, lifecycle and periodic consolidation.

**Default: on.** Enable/disable `memory` through `extensions.enabled` or `GREENHOUSE_EXTENSIONS`
(keep the other ids), then restart. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | Member feature `memory` defaults on. |
| Environment | None; model calls use the core model configuration/budget. |
| Owned tables | `memories` |
| Tools | `memory` (builtin profile contribution; member permissions still apply) |
| Routes | `/api/auth/me/memories` |
| Client | The Memory page: memories grouped in use, resting and archived; edit, pin, archive or restore, and delete. New memories come only from Sprouty's `memory` tool. |

The consolidation job belongs to this plugin.

Rules: [AGENTS.md](AGENTS.md). Plugin contract: [EXTENDING.md](../../EXTENDING.md).
