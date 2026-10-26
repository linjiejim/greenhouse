# Feedback plugin

Feature requests, member feedback, Agent friction reports and daily error/empty-search mining.

**Default: on.** Compiled by the upstream configuration. Enable/disable `feedback` through
`extensions.enabled` or `GREENHOUSE_EXTENSIONS`, retaining other enabled ids, then restart.
Credentials alone do not enable it. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | No plugin Runtime Config keys; administrative queue is super-only. |
| Environment | None. |
| Owned tables | `feedback` |
| Tools | `feature_request`, `feedback_query`, `log_friction` |
| Routes | `/api/admin/feature-requests`, `/api/admin/frictions`, `/api/me/feedback` |

Classic `#/feedback`; universal Feedback page. Contributes aggregate summaries and the friction-mining job.

See [plugin development](../../EXTENDING.md), [package rules](AGENTS.md) and
`api/index.ts` for registered contributions. Add new SQL after applied migrations; never edit
existing checksums. Test permission denials and disabled contributions as well as enabled behavior.
