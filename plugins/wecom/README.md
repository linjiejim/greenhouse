# WeCom plugin

Account binding, member direct-message notification delivery and group-webhook transport. Binding only; no login provider capability.

**Default: off.** Compiled by the upstream configuration. Enable/disable `wecom` through
`extensions.enabled` or `GREENHOUSE_EXTENSIONS`, retaining other enabled ids, then restart.
Credentials alone do not enable it. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | Bind through account settings; delivery recipients derive from the bound member. |
| Environment | `WECOM_CORP_ID`, `WECOM_AGENT_ID`, `WECOM_APP_SECRET`; `PUBLIC_BASE_URL` for callback; optional `SKILLS_WECOM_WEBHOOK_URL` / `SYNC_WECOM_WEBHOOK_URL` for registered webhook uses. |
| Owned tables | None; provider_connections and login_states are core tables |
| Tools | None |
| Routes | `/api/wecom` (binding and OAuth start/callback, mounted by the identity registry) |

Classic account binding/notification controls. Group webhooks and corporate-app direct messages are distinct transports.

See [plugin development](../../EXTENDING.md), [package rules](AGENTS.md) and
`api/index.ts` for registered contributions. Add new SQL after applied migrations; never edit
existing checksums. Test permission denials and disabled contributions as well as enabled behavior.
