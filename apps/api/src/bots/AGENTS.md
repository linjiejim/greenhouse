# Bots rules

A Bot is the one Agent identity: UI copy says Agent, while code keeps bot (tables, routes, `bot:<id>[@v]` handles) until the v2 rename. Short paths such as engine/turn.ts are relative to apps/api/src/bots.
Data-layer rules (single writer, MemoryScope, versions, bot_computers, vault storage) are in packages/db/src/AGENTS.md.
Endpoints are listed at the top of routes.ts, rooms.ts, public-routes.ts, computer/routes.ts and vault/routes.ts, with types in packages/types/src/bots.ts; change apps/web/src/lib/api/bots.ts and the mobile copy apps/mobile/src/shared/bots.ts with them.

## Identity
- Every member has exactly one Sprouty (ensureSproutyBot). It can be renamed but never archived or published (bot_protected), and POST /api/bots never creates one.
- Bots are private: only the owner, and super for support, may resolve, pin or run any version. Other members reach a public Agent only through the engine's public face and its published version, never its definition.
- Never rewrite stored greetings. When Sprouty's template role or instructions change, add the old wording to LEGACY_SPROUTY_COPY (sprouty.ts), or existing Sproutys stop following the account language.
- The bots flag gates bootstrap, conversations, rooms, public Agents, requests, tasks, computer and vault, never identity paths (guards in apps/api/src/index.ts).
- A Bot only proposes instruction changes through the self tool's instructions_update card; the member's acceptance appends the version.
- Bot tools are kind special and built per turn by the Bots engine; never expose them to chat, proxy or MCP.
- A Bot's reference folder is hidden from turns run as other Bots and from surfaces without a Bot identity.

## Privacy
- Bots conversations and bottask- sub-sessions are owner-only even for super (isOwnerOnlySession), and rooms are participant-only. `/api/bots/*` answers 404 for other members' rows, and these sessions are never shared.
- Keep Bots sessions out of generic lists, title search and session_query with defaultSessionListHiding.
- Runtime and eval queries over Bots work always pass the viewer (packages/db/src/bots-privacy.ts), so another member's Bots records stay hidden even after their session is deleted.
- Owners of a public Agent see usage, ratings and activity, never its conversations. Its knowledge reads re-authorize every call with the owner's current rights and the publication's grants (runKnowledgeAgentAction), never the user's rights, and are never cached.
- Notification facts and push payloads carry no message content, and page titles shown on cards never reach transcript rows or notifications.
- Run every entry point that acts as an Agent inside runInAgentScope (apps/api/src/platform/agent-scope.ts) so actor, audit and usage record `bot:<id>`.

## Engine
- Anything produced outside the running turn goes through deliverToConversation(), which writes when it can claim the run and queues to bot_inbox otherwise.
- Blue and green API slots share one database, so cross-process ownership (conversation runs, DevTools connections, process-exit wakeups) is claimed with pg advisory locks or conditional updates.
- In rooms every message keeps its author_user_id. Turns run as the original author, and continuations carry the real requester, never the room creator.
- Never start or continue a turn in a legacy group conversation (group_closed); queued items are only recorded.
- Approval cards are the only consent for write tools: the model's confirm:true never counts, and mcp_call asks inside the tool for each non-read-only call. Cards show what will actually happen (the stored draft); translated labels and values change display only.
- Card truncation markers (`…(+N more characters)`, `+K more fields`) are parsed by clients; keep them in English.
- A turn that read outside content (web pages, shell output, connector text, other Bots) or that the member did not start cannot write or change user-level memory, and each vault fill in it needs a card. Speaker labels neutralize forged `[name]:` headers.
- Background tasks are read-only, get no mail or other conversations, start from the confirmed brief only, and lock every later browser action before reading private context.
- External callers (MCP, CLI, Feishu) can message Agents but never decide cards; cards are answered only in the app.
- Agent-to-Agent messages re-check authorization before running and before replying, and an Agent's text never carries a person's authorization.
- Read receipts advance only by server-verified message seq, never by client time or now().

## Computer and vault
- Docker computers publish no ports and never reach the API; everything goes through docker exec. Hardened mode needs gVisor runsc, IPv6 and ICC off, and the `scripts/cloud-agent-net.sh --profile bots` egress rules; a failed check disables computers, not chat.
- E2B bridges listen on loopback, verify a per-uid HMAC secret and keep their ports owned by PID 1. Member data never passes through the SDK command API, member uids cannot reach link-local, private or bridge addresses, and an open egress probe fails only that computer (egress_open).
- Never restart an E2B desktop in place: new settings or templates mean a new sandbox and a home move, and a failed move keeps the old computer and fails only that member (ComputerStartError, never ComputerRuntimeError).
- Restore a backup only into a home built from scratch, never over an existing one. An unreadable backup key fails the start (restore_failed), and backup storage never sees plaintext or keys.
- Idle stop never kills work it cannot see: a failed job query counts as unknown, and computers waiting on a login or takeover card are skipped.
- Bump IMAGE_CONTRACT (computer/runtime.ts) with any change to the computer image contract; the API runs only matching images.
- Each Agent has its own computer: the computer layer keys by computer id (computerRef, parseComputerId), member-level state by user_id.
- Viewer and terminal tickets are 60-second, single-use and purpose-bound. Computer tools check lease_epoch before acting and before observing, and rfb-filter drops input from viewers without the lease.
- On deactivate, delete or bots flag-off, stop the member's runs first, then call purgeUserComputer(); failures only log.
- Vault fills need an exact main-frame origin match and never target Greenhouse's own origin; filled values join the redaction set, and login-card input is never stored, put in messages or shown to the model.
- An invalid VAULT_ENCRYPTION_KEY makes the vault unavailable instead of falling back to the provider key. A new ciphertext format or key source also updates `pnpm cli vault rekey` and `vault/__tests__/crypto.test.ts`.
- Human checks go to the member: never solve captchas, hide automation or spoof fingerprints, and only the member hands back.
- Port previews never run as Greenhouse: sandbox CSP without allow-same-origin, no cookies, no referrer, the member's Authorization and Cookie never forwarded, and bridge ports refused.
