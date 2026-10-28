# Feedback plugin

Feature requests, member feedback, Agent friction reports and daily error/empty-search mining.

**Default: on.** Enable/disable `feedback` through `extensions.enabled` or `GREENHOUSE_EXTENSIONS`
(keep the other ids), then restart. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | No plugin Runtime Config keys; the administrative queue is super-only. |
| Environment | None. |
| Owned tables | `feedback` |
| Tools | `feature_request`, `feedback_query`, `log_friction` |
| Routes | `/api/admin/feature-requests`, `/api/admin/frictions`, `/api/me/feedback` |
| Client | Send feedback from Me; supers triage in Admin › Issues & requests. |

Contributes aggregate summaries and the friction-mining job.

Rules: [AGENTS.md](AGENTS.md). Plugin contract: [EXTENDING.md](../../EXTENDING.md).
