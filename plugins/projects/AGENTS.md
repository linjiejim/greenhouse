# Projects plugin

- Compiled but off by default. Owns projects, members, tasks and comments; all services, platform manifest/handlers, routes/tools, classic list/board/Gantt/sidebar/peek UI, search, activity and seeds.

- Preserve `/api/projects*`, project tool ids, hash routes and the legacy `project` entity kind.
- `retiredToolAliases` keeps stored `project_manager` profiles working while enabled; disabled successors stay dormant.
- HTTP, chat and MCP dispatch the same platform handlers. Intersect entity/field policy with project visibility/membership. A denied record reads as missing; never bypass the task read authorizer for object titles or activity.
- DB access uses `services(db).projects`, never DatabaseProvider. Business dates are date columns; tags/dependencies are JSON arrays. Parent task delete sets child parent_id null; project/task/comment ownership cascades.
- Domain history uses core audit_events (`projects.activity`), not a second activity table. `activity.auditCapabilities` separates these rows from platform action changes. Feed scans share the host's cursor/bounded scan helpers and continue past unreadable rows.
- The plugin has no notification or digest producer. New producers must use the notification registry and core push queue.
- Register every owned table in resetTables and keep `0001_adopt.sql` (the plugin baseline) guarded so it also adopts 3.x tables in place. Disabled data remains; no core DROP. Classic copy lives under `ext.projects.*`.
