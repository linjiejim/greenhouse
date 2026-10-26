# Retro plugin

- Default off; dependsOn knowledge. Owns `/api/admin/retro`, the classic admin page/button and monthly schedule; owns no tables and declares no invented tools.
- Read usage only through the core summary facade. Never publish messages, member names or private titles. Feedback contributes aggregate sections without creating a dependency on its plugin.
- Preserve `team-retro-YYYY-MM`, the team folder `复盘`, existing document links and system notification payloads. Use Knowledge's typed service bag, never core internals.
- Schedule at 09:00 on the first in workspace time, after the prior UTC month ends plus 15 minutes. Replan on timezone changes and after each run; stop on shutdown. Use runExtensionJob for replica-safe scheduled claims.
- A manual request is super-only; invalid/future months fail. Model failure, no model or exhausted organization budget skips suggestions while preserving the report. Every model call uses the organization attempt-budget hook.
- Preserve idempotent document updates, versions, moved-folder placement and republishing on regeneration. Generated docs remain after disablement.
- Classic UI contributes an Administration module and an optional feedback.actions slot; it works when Feedback is disabled. Browser specs import only @playwright/test.
