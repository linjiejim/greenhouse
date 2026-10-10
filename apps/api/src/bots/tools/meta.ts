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
Actions: open {url} — open or navigate your tab; snapshot {from_line?} — read the page as an accessibility tree with [ref=eN] handles (a long page is cut: its marker names the from_line that shows the rest); click {ref}; type {ref, text, submit?}; select {ref, value}; hover {ref}; drag {ref, to_ref}; upload {ref, path} — put a file from the computer into a file input (≤20 MB); press {key}; scroll {direction}; wait {text?, timeout_s?} — until text appears, or a few seconds (≤30 s); back; tabs — list your tabs; close; screenshot — save a picture of the page for the member.
Every action returns the URL, title and a fresh snapshot; refs are valid only for the latest snapshot. Password, one-time-code and card fields always appear masked.
Sign in with the vault tool. A CAPTCHA or "verify you are human" page goes to the member automatically (blocked: human_check): end your turn, never try another address on that site. For anything else a person must do, call request_takeover. Never submit a payment, send a message to someone, delete something or accept terms without the member's explicit go-ahead.`,
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
Actions: shell {command, timeout_s?} — run bash in ~/work as user "agent" (no sudo, at most 120 s, long output is truncated); run_background {command, name?} — start long work (installs, builds, downloads, data runs) that keeps running after the call, output to a log; processes — list background processes; process_log {id, lines?} — the end of a process's log; stop_process {id}; read_file {path}; write_file {path, content}; share_file {path} — give the member a download link (≤20 MB); import_attachment {file_id, path?} — copy a file attached in this conversation into ~/work/inbox (or a path inside ~/work) to work on it with the shell (≤20 MB); status — whether the computer is up and who controls it.
Your whole home persists (not only ~/work): pip, npm -g and pipx installs go there and stay. Browser downloads land in ~/Downloads. The browser profile and its passwords are not reachable from the shell.
A server you start is reachable only from inside this computer: open its localhost address in the computer's browser to show it, never give that address to the member — their own browser cannot open it.`,
  },
  {
    ...base,
    id: 'request_takeover',
    name: 'Ask the member to step in',
    brief: 'Ask the member to sign in through a secure card, or to take over for a CAPTCHA',
    icon: 'Hand',
    sort_order: 92,
    description: `Ask the member to step in, then END your turn by telling them what you need.
kind: login — a sign-in page with no vault entry; otp — a one-time code; captcha — a CAPTCHA or bot check; other — anything else only a person can do.
login and otp put a secure sign-in card in the conversation: the member types into the card (you never see the values) and the server fills the page, so ask them to fill in the card rather than take over the browser. captcha and other ask them to take over the computer and hand it back.
reason: one sentence the member reads on the card. You are woken automatically when they are done.`,
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
  {
    ...base,
    id: 'self',
    name: 'Self',
    brief: 'Propose a change to your own standing instructions (the member decides)',
    icon: 'Pencil',
    sort_order: 97,
    description: `Propose a change to your own standing instructions. Action: propose_instructions {instructions, reason} — the complete new text (≤8000 characters) and why, in one or two sentences. Nothing changes until the member accepts the card they get; tell them in one line what you proposed. Use it when you learned a lasting lesson about how to do your job, never to bypass a rule they wrote.`,
  },
];

export const BOT_TOOL_IDS: readonly string[] = BOT_TOOL_METAS.map((m) => m.id);
