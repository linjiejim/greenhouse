# Email plugin

Personal/shared IMAP/SMTP mail, confirmed drafts and the email notification/password-link transport.

**Default: off.** Enable `email` through `extensions.enabled` or `GREENHOUSE_EXTENSIONS` (keep the
other ids), then restart. Credentials alone do not enable it; disabling preserves data.

| Surface | Details |
|---|---|
| Settings | Member feature `email` defaults on only while enabled. Shared mailbox access is super-only on the tool surface. |
| Environment | `SHARED_MAILBOX_ADDRESS`, `SHARED_MAILBOX_PASSWORD`, `SHARED_MAILBOX_IMAP_HOST/PORT`, `SHARED_MAILBOX_SMTP_HOST/PORT`, `SHARED_MAILBOX_USERNAME`, `SHARED_MAILBOX_DISPLAY_NAME`, `SHARED_MAILBOX_USE_TLS`, `SHARED_MAILBOX_USE_PROXY`, `SHARED_MAILBOX_ALLOWED_DOMAIN`; optional `MAIL_EGRESS_PROXY`. See root .env.example. |
| Owned tables | `email_accounts`; shared mailbox config is deployment env, not a row |
| Tools | `email_query`, `email_mutation` (human draft confirmation, not MCP/unattended) |
| Routes | `/api/email` |
| Client | The Email page: add a mailbox (provider presets, app password), edit it, test its connection and remove it; a saved password is never shown again. |

Mailbox reads are live IMAP; there is no background sync job. Sending uses the server-stored
draft and rechecks recipient/ownership limits. Automations can deliver results by email
(`notify.email`) while the plugin is enabled.

Rules: [AGENTS.md](AGENTS.md). Plugin contract: [EXTENDING.md](../../EXTENDING.md).
