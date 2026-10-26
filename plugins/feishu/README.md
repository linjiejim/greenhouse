# Feishu plugin

Existing-account binding/sign-in, personal notification delivery and optional Sprouty bot over a long connection.

**Default: off.** Compiled by the upstream configuration. Enable/disable `feishu` through
`extensions.enabled` or `GREENHOUSE_EXTENSIONS`, retaining other enabled ids, then restart.
Credentials alone do not enable it. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | Bind in account settings; public provider discovery shows login only when configured. No automatic account creation. |
| Environment | `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, optional `FEISHU_BOT_ENABLED=1`; `PUBLIC_BASE_URL` defines browser callbacks. Register the exact OAuth callback with the provider. |
| Owned tables | `feishu_conversations`, `feishu_receipts`; identity bindings/login state remain core |
| Tools | None; the bot calls the core member-scoped Agent runner |
| Routes | `/api/feishu` (binding/start/callback, login availability/start and code exchange) |

Classic account binding and login controls; mobile callback remains `greenhouse://auth/feishu`. Receipts expire after seven days. Configure both event and card callbacks as long connections for the bot.

See [plugin development](../../EXTENDING.md), [package rules](AGENTS.md) and
`api/index.ts` for registered contributions. Add new SQL after applied migrations; never edit
existing checksums. Test permission denials and disabled contributions as well as enabled behavior.
