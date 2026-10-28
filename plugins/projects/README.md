# Projects plugin

Projects, tasks, memberships, comments, list/board/Gantt, search and activity.

**Default: off.** Enable `projects` through `extensions.enabled` or `GREENHOUSE_EXTENSIONS` (keep the
other ids), then restart. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | No plugin Runtime Config keys; access uses the platform project/membership policies. |
| Environment | None. |
| Owned tables | `projects`, `project_members`, `tasks`, `task_comments` |
| Tools | `project_query`, `project_mutation` |
| Routes | `/api/projects` |
| Client | The Projects place (list, board, timeline) with task sheets; memberships are managed through the API. |

Preserves the `project` entity kind and the stored `project_manager` tool alias. Domain activity is
in core audit_events; there is no separate notification/digest producer.

Rules: [AGENTS.md](AGENTS.md). Plugin contract: [EXTENDING.md](../../EXTENDING.md).
