# Feishu plugin

Existing-account binding/sign-in, personal notification delivery and an optional Sprouty bot over a long connection.

**Default: off.** Enable `feishu` through `extensions.enabled` or `GREENHOUSE_EXTENSIONS` (keep the
other ids), then restart. Credentials alone do not enable it; disabling preserves data.

| Surface | Details |
|---|---|
| Settings | Public provider discovery shows sign-in only when configured. No automatic account creation. |
| Environment | `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, optional `FEISHU_BOT_ENABLED=1`; `PUBLIC_BASE_URL` defines browser callbacks. Register the exact OAuth callback with the provider. |
| Owned tables | `feishu_conversations`, `feishu_receipts`; identity bindings/login state remain core |
| Tools | None; the bot calls the core member-scoped Agent runner |
| Routes | `/api/feishu` (binding/start/callback, login availability/start and code exchange) |
| Client | A Feishu button on `/login` and binding under Me › Connections (`/bindings`); the native app's callback is `greenhouse://auth/feishu`. |

Receipts expire after seven days. Configure both event and card callbacks as long connections for
the bot.

Rules: [AGENTS.md](AGENTS.md). Plugin contract: [EXTENDING.md](../../EXTENDING.md).
