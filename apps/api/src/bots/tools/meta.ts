/**
 * Bot tool catalog entries — metadata only.
 *
 * These tools exist only inside Bots conversations: the Bots engine
 * (bots/engine) builds them per turn with the Bot, the conversation and the
 * running ChatRun in hand, none of which the generic lazy-tool context has. In
 * the catalog they are `special` (SPECIAL_METAS in tools/registry.ts), carry
 * `context: 'bots'` so GET /api/tools and the Agent editor leave them out, and
 * declare no `surface`, so the /api/agent proxy and /api/mcp never reach them.
 * They ride the `bots` feature point.
 *
 * A zero-import leaf (types only), so feature-points.ts and the registry can
 * import it without a cycle. Descriptions are sent to the model on every step:
 * keep them tight (tools/__tests__/description-budget.test.ts).
 */

import type { ToolMeta } from '../../tools/define.js';

const base = {
  category: 'core',
  is_global: false,
  context: 'bots',
} as const satisfies Partial<ToolMeta>;

export const BOT_TOOL_METAS: readonly ToolMeta[] = [
  {
    ...base,
    id: 'browser',
    name: 'Browser',
    brief: "Drive the Bot's own tab in the member's computer browser",
    icon: 'Globe',
    runtime_risk: 'r1',
    sort_order: 90,
    description: `Your own tab in the browser on the member's computer (a real Chromium they can watch live).
Actions: open {url} — open or navigate your tab; snapshot — read the page as an accessibility tree with [ref=eN] handles; click {ref}; type {ref, text, submit?}; select {ref, value}; press {key}; scroll {direction}; back; tabs — list your tabs; close; screenshot — save a picture of the page for the member.
Every action returns the URL, title and a fresh snapshot; refs are valid only for the latest snapshot. Password, one-time-code and card fields always appear masked.
Sign in with the vault tool; for CAPTCHAs or anything a person must do, call request_takeover. Never submit a payment, send a message to someone, delete something or accept terms without the member's explicit go-ahead.`,
  },
  {
    ...base,
    id: 'computer',
    name: 'Computer',
    brief: "Run commands and work with files on the member's computer",
    icon: 'Monitor',
    runtime_risk: 'r1',
    sort_order: 91,
    description: `The member's computer (Linux; shared by all their Bots; files persist).
Actions: shell {command, timeout_s?} — run bash in ~/work as user "agent" (no sudo, at most 120 s, long output is truncated); read_file {path}; write_file {path, content}; share_file {path} — give the member a download link (≤20 MB); import_attachment {file_id, path?} — copy a file attached in this conversation into ~/work/inbox (or a path inside ~/work) to work on it with the shell (≤20 MB); status — whether the computer is up and who controls it.
Browser downloads land in ~/Downloads. The browser profile and its passwords are not reachable from the shell.`,
  },
  {
    ...base,
    id: 'request_takeover',
    name: 'Ask the member to step in',
    brief: 'Hand the computer to the member for a sign-in, code or CAPTCHA',
    icon: 'Hand',
    sort_order: 92,
    description: `Ask the member to step in on the computer, then END your turn by telling them what you need.
kind: login — a sign-in page with no vault entry (they fill a secure form you never see); otp — a one-time code; captcha — a CAPTCHA or bot check; other — anything else only a person can do.
reason: one sentence the member reads. When they hand back you are woken automatically to continue.`,
  },
  {
    ...base,
    id: 'vault',
    name: 'Password vault',
    brief: "Fill the member's saved logins into the page without seeing them",
    icon: 'KeyRound',
    sort_order: 93,
    description: `The member's password vault. You never see a secret: the server fills it straight into your current browser page.
Actions: list — entries (label, sites, masked username); fill_login {item_id, submit?} — fill username and password on the page you are on (the page's site must match the entry; the member may be asked to approve); fill_totp {item_id} — compute and fill the entry's one-time code.
No matching entry → request_takeover with kind login. Never ask the member to type a password in chat.`,
  },
  {
    ...base,
    id: 'team',
    name: 'Team',
    brief: 'Hand work to, invite or propose other Bots',
    icon: 'Users',
    sort_order: 94,
    description: `Work with the member's other Bots in this conversation.
Actions: list — members and the member's other Bots; ask {bot_id, message} — hand a piece of work to a member Bot. It answers next, visibly, and your turn ends after the hand-off, so add one line saying what you handed over. add {bot_id} — invite one of the member's existing Bots into this conversation. create {name, role, instructions} — propose a new Bot; it exists only after the member confirms the card.
One owner per step: never ask a Bot to redo what another already did.`,
  },
  {
    ...base,
    id: 'conversation',
    name: 'Shared notes',
    brief: "The conversation's shared notes and searchable history",
    icon: 'StickyNote',
    sort_order: 95,
    description: `This conversation's shared memory.
Actions: notes — list the shared notes (decisions, open items, facts every Bot here should know); add_note {title, body?}; update_note {id, title?, body?}; resolve_note {id} — mark done; recall {query} — search earlier messages of this conversation that were summarised out of your context (returns snippets with dates).`,
  },
  {
    ...base,
    id: 'bot_tasks',
    name: 'Background tasks',
    brief: 'Propose read-only background work that reports back',
    icon: 'ListTodo',
    sort_order: 96,
    description: `Background work that keeps going while the member chats.
Actions: start {title, brief} — propose a background task; the member presses Start on a card. It runs read-only (browse, read, summarise — no form submits, no shell) and reports back here when done, so write a self-contained brief. list — this conversation's tasks; cancel {run_id}.`,
  },
];

export const BOT_TOOL_IDS: readonly string[] = BOT_TOOL_METAS.map((m) => m.id);
