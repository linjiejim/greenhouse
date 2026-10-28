# WeCom plugin

Account binding, member direct-message notification delivery and group-webhook transport. Binding only; no login provider capability.

**Default: off.** Enable `wecom` through `extensions.enabled` or `GREENHOUSE_EXTENSIONS` (keep the
other ids), then restart. Credentials alone do not enable it; disabling preserves bindings.

| Surface | Details |
|---|---|
| Settings | Delivery recipients derive from the bound member. |
| Environment | `WECOM_CORP_ID`, `WECOM_AGENT_ID`, `WECOM_APP_SECRET`; `PUBLIC_BASE_URL` for the callback; optional `SKILLS_WECOM_WEBHOOK_URL` for registered webhook uses. |
| Owned tables | None; provider_connections and login_states are core tables |
| Tools | None |
| Routes | `/api/wecom` (binding and OAuth start/callback, mounted by the identity registry) |
| Client | Binding under Me › Connections (`/bindings`); automations can deliver to WeCom (`notify.wecom`, group webhooks). |

Group webhooks and corporate-app direct messages are distinct transports.

Rules: [AGENTS.md](AGENTS.md). Plugin contract: [EXTENDING.md](../../EXTENDING.md).
