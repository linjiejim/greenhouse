# Email plugin

Personal/shared IMAP/SMTP mail, confirmed drafts and the email notification/password-link transport.

**Default: off.** Compiled by the upstream configuration. Enable/disable `email` through
`extensions.enabled` or `GREENHOUSE_EXTENSIONS`, retaining other enabled ids, then restart.
Credentials alone do not enable it. Disabling preserves data.

| Surface | Details |
|---|---|
| Settings | Member feature `email` defaults on only while enabled. Members bind their own accounts in settings; shared mailbox access is super-only on the tool surface. |
| Environment | `SHARED_MAILBOX_ADDRESS`, `SHARED_MAILBOX_PASSWORD`, `SHARED_MAILBOX_IMAP_HOST/PORT`, `SHARED_MAILBOX_SMTP_HOST/PORT`, `SHARED_MAILBOX_USERNAME`, `SHARED_MAILBOX_DISPLAY_NAME`, `SHARED_MAILBOX_USE_TLS`, `SHARED_MAILBOX_USE_PROXY`, `SHARED_MAILBOX_ALLOWED_DOMAIN`; optional `MAIL_EGRESS_PROXY`. See root .env.example. |
| Owned tables | `email_accounts`; shared mailbox config is deployment env, not a row |
| Tools | `email_query`, `email_mutation` (human draft confirmation, not MCP/unattended) |
| Routes | `/api/email` |

Classic `#/settings/email`; universal Email page. Mailbox reads are live IMAP; no background sync job. Sending uses the server-stored draft and rechecks recipient/ownership limits.

See [plugin development](../../EXTENDING.md), [package rules](AGENTS.md) and
`api/index.ts` for registered contributions. Add new SQL after applied migrations; never edit
existing checksums. Test permission denials and disabled contributions as well as enabled behavior.
