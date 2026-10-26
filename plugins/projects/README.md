# Projects plugin

Projects, tasks, memberships, comments, list/board/Gantt, search and activity.

**Default: off.** Compiled by the upstream configuration. Enable/disable `projects` through
`extensions.enabled` or `GREENHOUSE_EXTENSIONS`, retaining other enabled ids, then restart.
Credentials alone do not enable it. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | No plugin Runtime Config keys; access uses the platform project/membership policies. |
| Environment | None. |
| Owned tables | `projects`, `project_members`, `tasks`, `task_comments` |
| Tools | `project_query`, `project_mutation` |
| Routes | `/api/projects` |

Classic `#/projects`; universal native Projects place. Preserves the `project` entity kind and stored `project_manager` tool alias. Domain activity is in core audit_events; there is no separate notification/digest producer.

See [plugin development](../../EXTENDING.md), [package rules](AGENTS.md) and
`api/index.ts` for registered contributions. Add new SQL after applied migrations; never edit
existing checksums. Test permission denials and disabled contributions as well as enabled behavior.
