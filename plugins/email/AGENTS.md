# Email plugin

- Shared plugin rules: [root AGENTS.md](../../AGENTS.md) (Plugins) and [EXTENDING.md](../../EXTENDING.md); this file lists only Email-specific rules.
- Default off; activation requires configured enablement and restart, independently of credentials.
- Own email_accounts, schema, services, routes, tools and the email transport; use services(db), never DatabaseProvider fields.
- Preserve env names, URLs, tool ids, preference keys and applied migration bytes; disablement retains all data.
- The member email flag defaults on while active; routes require internal identity plus feature and tools belong to the same point.
- Use explicit IMAP/SMTP app-password accounts; reads fail explicitly rather than returning an empty inbox on errors.
- Resolve folders by exact path, SPECIAL-USE role, then same name; unknown folders report available choices.
- Attach the IMAP error listener before connect, close failed connections and describe command errors at the shared withImap boundary.
- Personal mailboxes belong to one member; shared mailbox configuration stays in deployment env and is super-only on the Agent tool surface.
- Normalize mailbox addresses to stable account/shared refs before storing drafts; never weaken ownership/disabled/shared checks.
- sendMail is the single send path: ownership, recipient policy, daily/attachment budgets, send and audit.
- Draft and send share checkRecipientPolicy; send uses the exact server-stored draft and rejects invalid tokens without fallback.
- Sanitize all retrieved mail for LLM use; remove zero-width characters before role/tool marker detection and cap body text.
- Direct egress resolves public DNS and connects to that checked IP with original TLS SNI; configured proxy failures never fall back silently.
- Keep import-time limits in the leaf limits module and forbid email_mutation in unattended contexts/MCP.
- System notification mail uses the registered transport and bound recipient, never an unrestricted Agent send tool.
- The client lists accounts read-only (native page `email`); account create/edit stays on `/api/email/accounts`.
- Register reset tables/migrations and keep [schema](db-schema.md) current.
