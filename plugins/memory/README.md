# Memory plugin

Personal long-term memory, pinned notes, lifecycle and periodic consolidation.

**Default: on.** Compiled by the upstream configuration. Enable/disable `memory` through
`extensions.enabled` or `GREENHOUSE_EXTENSIONS`, retaining other enabled ids, then restart.
Credentials alone do not enable it. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | Member feature `memory` defaults on; personal settings page. |
| Environment | None; model calls use the core model configuration/budget. |
| Owned tables | `memories` |
| Tools | `memory` (builtin profile contribution; member permissions still apply) |
| Routes | `/api/auth/me/memories` |

Classic `#/settings/memory`; universal Memory page. The consolidation job belongs to this plugin.

See [plugin development](../../EXTENDING.md), [package rules](AGENTS.md) and
`api/index.ts` for registered contributions. Add new SQL after applied migrations; never edit
existing checksums. Test permission denials and disabled contributions as well as enabled behavior.
