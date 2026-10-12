/**
 * Bots API — the member's Bots, their conversations, background tasks and the
 * "needs you" requests (`/api/bots*`), and rooms with other people (`/api/rooms*`; endpoint table in
 * apps/api/src/bots/AGENTS.md → HTTP contract). Function names follow the web
 * client (apps/web/src/lib/api/bots.ts); sending a message is `POST /api/chat`
 * (`openBotsChat` in ./chat.ts), not this module.
 *
 * Mobile convention: nothing here throws. Reads answer `BotsRead<T>` and writes
 * `BotsWrite<T>`, which keep apart what the screens treat differently:
 * `status` 0 = the request never got an answer (offline), 403 = Bots are off for
 * this account, 404 = gone (or an older server without Bots), and the server's
 * machine-readable `code` (`bot_name_taken`, `already_decided`, `member_limit`…)
 * so callers explain a refusal in the member's language. A write also carries
 * the server's own `{ error }` sentence as `message` ('' when there was none).
 *
 * Gating (06 C6): the identity routes (`GET/POST/PATCH/DELETE /api/bots`,
 * memories) need an internal account only; bootstrap, conversations, requests
 * and tasks also need the `bots` feature.
 *
 * Timestamps: the Bots routes serialise Postgres text timestamps
 * ("2026-10-08 05:05:34.202+00"), which Hermes' `Date.parse` rejects. Every
 * `*_at` field of an answer is rewritten to ISO-8601 here, once, so the code
 * vendored from the web (`elapsed`, the transcript's later-line check) and the
 * store's selectors can keep calling `Date.parse`.
 */

import type {
  BotActivityItem,
  BotConversationDetail,
  BotConversationSummary,
  BotMessage,
  BotSharedNoteView,
  BotRequestDecision,
  BotRequestStatus,
  BotRequestView,
  BotTaskView,
  BotUsageView,
  BotView,
  ComputerFileList,
  SharedBotView,
  ComputerProcessLog,
  ComputerProcessView,
  ComputerStatusView,
} from '../shared/bots';
import type { BotMemoryView, BotsOverview, BotWriteInput, ConversationPage } from '../shared/bots-wire';
import { api } from './client';

/** A read: the value, or why there is none (status 0 = network). */
export type BotsRead<T> = { ok: true; value: T } | { ok: false; status: number; code: string | null };
/** A write: the value, or the refusal (status 0 = network) with the server's code and sentence. */
export type BotsWrite<T> = { ok: true; value: T } | { ok: false; status: number; code: string | null; message: string };

const enc = encodeURIComponent;

/** The server's `{ error, code? }` from a failed response; empty when the body is not JSON. */
async function errorBody(res: Response): Promise<{ code: string | null; message: string }> {
  const data: unknown = await res.json().catch(() => null);
  const body: { error?: unknown; code?: unknown } = data && typeof data === 'object' ? data : {};
  return {
    code: typeof body.code === 'string' ? body.code : null,
    message: typeof body.error === 'string' ? body.error : '',
  };
}

/** One call, never thrown: `pick` maps the OK body to the value. */
async function call<T>(path: string, init: RequestInit, pick: (body: unknown) => T): Promise<BotsWrite<T>> {
  let res: Response;
  try {
    res = await api(path, init);
  } catch {
    return { ok: false, status: 0, code: null, message: '' };
  }
  if (!res.ok) return { ok: false, status: res.status, ...(await errorBody(res)) };
  try {
    // 200 with an empty body (`{ ok: true }` routes answer JSON, but be lenient).
    const text = await res.text();
    return { ok: true, value: pick(text ? isoTimestamps(JSON.parse(text)) : null) };
  } catch {
    // An answer we cannot read is as good as none.
    return { ok: false, status: 0, code: null, message: '' };
  }
}

/** A Postgres text timestamp: date, time (fraction optional), zone `Z` / `+HH` / `+HHMM` / `+HH:MM`. */
const PG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/** One timestamp as ISO-8601 (milliseconds, `±HH:MM`); anything else is returned untouched. */
export function isoTimestamp(value: string): string {
  const m = PG_TIMESTAMP.exec(value);
  if (!m) return value;
  const [, date, time, fraction = '', zone] = m;
  const ms = fraction ? `.${fraction.slice(1, 4).padEnd(3, '0')}` : '';
  const offset = zone === 'Z' ? 'Z' : `${zone.slice(0, 3)}:${zone.replace(':', '').slice(3, 5) || '00'}`;
  return `${date}T${time}${ms}${offset}`;
}

/** Opaque subtrees (tool traces, card payloads, avatars): their keys are content, not our timestamps. */
const OPAQUE = new Set(['pipeline', 'references', 'payload', 'result', 'avatar', 'bot_event', 'input', 'output']);

/** Rewrite every `*_at` string in an answer with `isoTimestamp` (see the header). */
function isoTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(isoTimestamps);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (OPAQUE.has(key)) out[key] = field;
    else if (typeof field === 'string') out[key] = key.endsWith('_at') ? isoTimestamp(field) : field;
    else out[key] = isoTimestamps(field);
  }
  return out;
}

/** A read is a call without the message. */
async function read<T>(path: string, pick: (body: unknown) => T): Promise<BotsRead<T>> {
  const result = await call(path, {}, pick);
  return result.ok ? result : { ok: false, status: result.status, code: result.code };
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return body === undefined
    ? { method }
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const whole = <T>(body: unknown) => body as T;
const nothing = (): void => undefined;

// ─── Bots ────────────────────────────────────────────────

/**
 * Active + archived Bots, other members' public Agents in the member's DMs (`shared_bots`, P4 —
 * missing from servers older than 2026-10-12: read it as optional), the computer runtime, the
 * vault flag and the pending-card count.
 */
export function listBots(): Promise<BotsRead<BotsOverview>> {
  return read('/api/bots', whole<BotsOverview>);
}

/** Sprouty + its DM + greeting, created when missing (idempotent; needs the `bots` feature). */
export function bootstrapBots(): Promise<BotsWrite<{ bot: BotView; dm_session_id: string; created: boolean }>> {
  return call(
    '/api/bots/bootstrap',
    jsonInit('POST'),
    whole<{ bot: BotView; dm_session_id: string; created: boolean }>,
  );
}

/** A new Bot (from a gallery template or custom); `dm_session_id` is null while Bots are off. */
export function createBot(input: BotWriteInput): Promise<BotsWrite<{ bot: BotView; dm_session_id: string | null }>> {
  return call('/api/bots', jsonInit('POST', input), whole<{ bot: BotView; dm_session_id: string | null }>);
}

/** Every save appends a version (`current_version`). */
export function updateBot(
  botId: string,
  input: Omit<BotWriteInput, 'template_key'>,
): Promise<BotsWrite<{ bot: BotView }>> {
  return call(`/api/bots/${enc(botId)}`, jsonInit('PATCH', input), whole<{ bot: BotView }>);
}

/** Archive (Sprouty answers 400 `bot_protected`). Its conversation stays readable. */
export function archiveBot(botId: string): Promise<BotsWrite<void>> {
  return call(`/api/bots/${enc(botId)}`, jsonInit('DELETE'), nothing);
}

export function listBotMemories(botId: string): Promise<BotsRead<BotMemoryView[]>> {
  return read(`/api/bots/${enc(botId)}/memories`, (body) => (body as { memories: BotMemoryView[] }).memories);
}

export function deleteBotMemory(botId: string, memoryId: number): Promise<BotsWrite<void>> {
  return call(`/api/bots/${enc(botId)}/memories/${memoryId}`, jsonInit('DELETE'), nothing);
}

/**
 * Undo a "remembered for all Bots" receipt: archive the member's own memory
 * (`PATCH /api/auth/me/memories/:id`, the web's `archiveUserMemory`). 404 = already gone.
 */
export function archiveUserMemory(memoryId: number): Promise<BotsWrite<void>> {
  return call(`/api/auth/me/memories/${memoryId}`, jsonInit('PATCH', { status: 'archived' }), nothing);
}

// ─── Conversations ───────────────────────────────────────

/** Newest activity first, at most 100, no paging. */
export function listConversations(): Promise<BotsRead<BotConversationSummary[]>> {
  return read('/api/bots/conversations', (body) => (body as { conversations: BotConversationSummary[] }).conversations);
}

/** One Bot's DM — created if needed (one id only: groups are retired, 400 `groups_retired`). */
export function createConversation(input: {
  bot_ids: string[];
  title?: string;
}): Promise<BotsWrite<BotConversationDetail>> {
  return call('/api/bots/conversations', jsonInit('POST', input), conversationOf);
}

// ─── Task chats (separate chats on the Agents engine, spec 20261011-agent-first-class §5a) ─

/**
 * The member's task chats (`?kind=task`), newest activity first — the drawer's chat rows read
 * their signals (needs you, unread, replying) from here. An older server ignores `kind` and answers
 * with its threads: only `kind: 'task'` rows are kept.
 */
export function listTaskChats(): Promise<BotsRead<BotConversationSummary[]>> {
  return read('/api/bots/conversations?kind=task', (body) =>
    (body as { conversations: BotConversationSummary[] }).conversations.filter((row) => row.kind === 'task'),
  );
}

/**
 * A new task chat answered by `bot_id` (absent = the member's Sprouty). 201 with its detail. An
 * older server reads this as a DM request without `bot_ids`: 400 with no code (`taskChatFailure`
 * in src/bots/task-chats.ts tells the two apart).
 */
export function createTaskChat(
  input: { bot_id?: string; title?: string; model_id?: string } = {},
): Promise<BotsWrite<BotConversationDetail>> {
  return call('/api/bots/conversations', jsonInit('POST', { kind: 'task', ...input }), conversationOf);
}

/** A task chat's title / model (a DM answers 409 `not_task_chat`). */
export function updateTaskChat(
  sessionId: string,
  patch: { title?: string | null; model_id?: string | null },
): Promise<BotsWrite<BotConversationDetail>> {
  return call(`/api/bots/conversations/${enc(sessionId)}`, jsonInit('PATCH', patch), conversationOf);
}

/** A page of the transcript (`seq` ascending): the newest, or the one before `beforeSeq`. */
export function getConversation(
  sessionId: string,
  opts: { beforeSeq?: number; limit?: number } = {},
): Promise<BotsRead<ConversationPage>> {
  const query: string[] = [];
  if (opts.beforeSeq !== undefined) query.push(`before_seq=${opts.beforeSeq}`);
  if (opts.limit !== undefined) query.push(`limit=${opts.limit}`);
  const path = `/api/bots/conversations/${enc(sessionId)}${query.length ? `?${query.join('&')}` : ''}`;
  return read(path, (body) => {
    const page = body as ConversationPage;
    return { ...page, messages: page.messages.map(withMessageRole) };
  });
}

/**
 * The route types `role` as the column's plain string; a transcript row is one
 * of three. Narrowed by value — anything unexpected reads as a Bot reply (the
 * web's `withMessageRole`).
 */
function withMessageRole(message: BotMessage): BotMessage {
  const role: string = message.role;
  return role === 'user' || role === 'system' || role === 'assistant' ? message : { ...message, role: 'assistant' };
}

/** A DM's owner cannot be removed (400 `cannot_remove_owner`). */
export function removeConversationMember(sessionId: string, botId: string): Promise<BotsWrite<BotConversationDetail>> {
  return call(`/api/bots/conversations/${enc(sessionId)}/members/${enc(botId)}`, jsonInit('DELETE'), conversationOf);
}

/** Mark read (best effort — callers ignore a failure). */
export async function markConversationRead(sessionId: string, throughMessageId?: string): Promise<boolean> {
  const result = await call(
    `/api/bots/conversations/${enc(sessionId)}/read`,
    jsonInit('POST', throughMessageId ? { through_message_id: throughMessageId } : undefined),
    nothing,
  );
  return result.ok;
}

function conversationOf(body: unknown): BotConversationDetail {
  return (body as { conversation: BotConversationDetail }).conversation;
}

// ─── Public Agents (spec 20261011-agent-first-class P4) ──

/** Other members' public Agents offered to this member, not their own (404 on servers without them). */
export function listAgents(): Promise<BotsRead<SharedBotView[]>> {
  return read('/api/agents', (body) => (body as { agents: SharedBotView[] }).agents);
}

/** The member's own DM with a public Agent — made with its greeting when missing. 404 = no longer offered. */
export function startAgentConversation(agentId: string): Promise<BotsWrite<string>> {
  return call(
    `/api/agents/${enc(agentId)}/conversation`,
    jsonInit('POST'),
    (body) => (body as { conversation_id: string }).conversation_id,
  );
}

/**
 * Rate a reply (👍 1 / 👎 -1, an optional sentence ≤ 1000) — its owner sees the rating and the
 * sentence, never the conversation (D38). Rating again replaces it. 404 = not a reply here.
 */
export function rateReply(
  sessionId: string,
  messageId: string,
  body: { rating: 1 | -1; comment?: string },
): Promise<BotsWrite<void>> {
  return call(
    `/api/bots/conversations/${enc(sessionId)}/messages/${enc(messageId)}/feedback`,
    jsonInit('POST', body),
    nothing,
  );
}

/** Take a rating back — the reply is unrated again. */
export function unrateReply(sessionId: string, messageId: string): Promise<BotsWrite<void>> {
  return call(
    `/api/bots/conversations/${enc(sessionId)}/messages/${enc(messageId)}/feedback`,
    jsonInit('DELETE'),
    nothing,
  );
}

// ─── Rooms: conversations with other people (spec 20261011-agent-first-class P5) ─
//
// A room is a Bots conversation of kind `room`: it comes back in `listConversations` for every
// participant (with `participants`, and each Agent's `owner_user_id` / `addressable` for this
// reader), its transcript is `getConversation`, and a message is `POST /api/chat` like any thread —
// always 202 there (nobody answers unless someone allowed @-mentions an Agent). These are the
// routes only a room has. A server without rooms answers 404.

/** Someone who can be in a conversation with the member: active, internal, Agents on (never the member). */
export interface RoomPerson {
  id: string;
  nickname: string;
  email: string;
}

/** Who the member can start a conversation with, or add to one (sorted by name, ≤ 500). */
export function listRoomPeople(): Promise<BotsRead<RoomPerson[]>> {
  return read('/api/rooms/people', (body) => (body as { people: RoomPerson[] }).people);
}

/**
 * A new room with these people (the member is in it anyway), an optional title and some of the
 * member's own Agents. One other person, no title, no Agents = the pair's private chat: the existing
 * one comes back (200) instead of a new one (201). Refusals: 400 (someone who can't join), 404 (an
 * Agent that isn't the member's), 409 (a public Agent not offered to everyone; `room_full`).
 */
export function createRoom(input: {
  user_ids: string[];
  title?: string;
  bot_ids?: string[];
}): Promise<BotsWrite<BotConversationDetail>> {
  return call('/api/rooms', jsonInit('POST', input), conversationOf);
}

/** Its title (anyone in it); null clears it — the room is named after its people again. */
export function renameRoom(sessionId: string, title: string | null): Promise<BotsWrite<BotConversationDetail>> {
  return call(`/api/rooms/${enc(sessionId)}`, jsonInit('PATCH', { title }), conversationOf);
}

/** Add someone (anyone in it may). A public Agent the newcomer isn't offered leaves, with a line. */
export function addRoomPerson(sessionId: string, userId: string): Promise<BotsWrite<BotConversationDetail>> {
  return call(`/api/rooms/${enc(sessionId)}/participants`, jsonInit('POST', { user_id: userId }), conversationOf);
}

/**
 * Take someone out — the member themself (leaving: their Agents go with them), or, as its owner,
 * anyone. `deleted` = they were the last one: the room is gone. 409 `busy`: their Agent is answering.
 */
export function removeRoomPerson(sessionId: string, userId: string): Promise<BotsWrite<{ deleted: boolean }>> {
  return call(`/api/rooms/${enc(sessionId)}/participants/${enc(userId)}`, jsonInit('DELETE'), (body) => ({
    deleted: (body as { deleted?: unknown } | null)?.deleted === true,
  }));
}

/** Leave: `removeRoomPerson` with the member's own id. A room can't be deleted — the last one out deletes it. */
export function leaveRoom(sessionId: string, me: string): Promise<BotsWrite<{ deleted: boolean }>> {
  return removeRoomPerson(sessionId, me);
}

/** Bring an Agent in: one of the member's own, or a public one offered to everyone in the room (else 409). */
export function addRoomAgent(sessionId: string, botId: string): Promise<BotsWrite<BotConversationDetail>> {
  return call(`/api/rooms/${enc(sessionId)}/agents`, jsonInit('POST', { bot_id: botId }), conversationOf);
}

/** Take an Agent out — whoever brought it, its owner or the room's owner may (else 403). */
export function removeRoomAgent(sessionId: string, botId: string): Promise<BotsWrite<void>> {
  return call(`/api/rooms/${enc(sessionId)}/agents/${enc(botId)}`, jsonInit('DELETE'), nothing);
}

// ─── Shared notes (a conversation's) ─────────────────────

/** Add a note (title ≤ 80, body ≤ 2000) — the member's own (no author Bot). */
export function addNote(
  sessionId: string,
  note: { title: string; body?: string },
): Promise<BotsWrite<BotSharedNoteView>> {
  return call(`/api/bots/conversations/${enc(sessionId)}/notes`, jsonInit('POST', note), noteOf);
}

export function updateNote(
  sessionId: string,
  noteId: number,
  patch: { title?: string; body?: string; status?: 'open' | 'done'; pinned?: boolean },
): Promise<BotsWrite<BotSharedNoteView>> {
  return call(`/api/bots/conversations/${enc(sessionId)}/notes/${noteId}`, jsonInit('PATCH', patch), noteOf);
}

/** 404 = already gone. */
export function deleteNote(sessionId: string, noteId: number): Promise<BotsWrite<void>> {
  return call(`/api/bots/conversations/${enc(sessionId)}/notes/${noteId}`, jsonInit('DELETE'), nothing);
}

function noteOf(body: unknown): BotSharedNoteView {
  return (body as { note: BotSharedNoteView }).note;
}

// ─── A Bot's private reference folder ────────────────────

export interface BotFilesView {
  folder: { id: number; name: string; url: string } | null;
  /** Its documents (≤ 100), `url` an in-app entity link (`#/knowledge/doc/<id>-<slug>`). */
  docs: Array<{ id: number; doc_id: string; title: string; url: string; updated_at: string }>;
}

export function listBotFiles(botId: string): Promise<BotsRead<BotFilesView>> {
  return read(`/api/bots/${enc(botId)}/files`, whole<BotFilesView>);
}

// ─── Background tasks ────────────────────────────────────

export function listConversationTasks(sessionId: string): Promise<BotsRead<BotTaskView[]>> {
  return read(`/api/bots/conversations/${enc(sessionId)}/tasks`, (body) => (body as { tasks: BotTaskView[] }).tasks);
}

/**
 * The member's tasks across every conversation: still going, plus those that ended in the last
 * half hour (the phone's Live Activities reconcile against it). 404 on servers older than it.
 */
export function listMemberTasks(): Promise<BotsRead<BotTaskView[]>> {
  return read('/api/bots/tasks?state=active', (body) => (body as { tasks: BotTaskView[] }).tasks);
}

/** 404 unknown, 409 already finished. */
export function cancelBotTask(runId: string): Promise<BotsWrite<void>> {
  return call(`/api/bots/tasks/${enc(runId)}/cancel`, jsonInit('POST'), nothing);
}

// ─── "Needs you" requests ────────────────────────────────

/** Newest first, at most 200, across every conversation; no status = every status. */
export function listRequests(status?: BotRequestStatus): Promise<BotsRead<BotRequestView[]>> {
  return read(
    `/api/bots/requests${status ? `?status=${status}` : ''}`,
    (body) => (body as { requests: BotRequestView[] }).requests,
  );
}

/**
 * Settle a card. A 409 `already_decided` / `deciding` (or code-less) means it
 * was settled elsewhere; any other 409 code means the server could not carry
 * it out and the card stays pending (`classifyDecision` in src/bots/requests.ts).
 * The sign-in values in `body.login` go out in this body only — never logged.
 */
export function decideRequest(requestId: string, body: BotRequestDecision): Promise<BotsWrite<BotRequestView>> {
  return call(
    `/api/bots/requests/${enc(requestId)}`,
    jsonInit('POST', body),
    (res) => (res as { request: BotRequestView }).request,
  );
}

// ─── An Agent's computer (spec docs/specs/20261011-mobile-computer.md) ─
//
// One computer per Agent (spec 20261011-agent-first-class P3a): every call takes
// the Agent whose computer it is — `bot`, null / absent = the member's main Agent
// (Sprouty), whose computer is the one every member had before 2026-10-12. The
// server reads `?bot=<id>` (an unknown or foreign id: 404 `agent_not_found`); an
// older server ignores it and answers for the one computer it knows.
// The screen itself is a WebSocket the viewer page opens with a one-time ticket
// (`computerViewToken`); everything else is plain REST. Only `takeover`,
// `handback` and `typeIntoComputer` touch the lease.

/** `path` for the computer of `bot` (null = the main Agent's: no parameter). */
export function computerPath(path: string, bot?: string | null): string {
  if (!bot) return path;
  return `${path}${path.includes('?') ? '&' : '?'}bot=${enc(bot)}`;
}

/** Its state, who controls it (`bot` / `user`), the start queue, the runtime behind it. */
export function computerStatus(bot?: string | null): Promise<BotsRead<ComputerStatusView>> {
  return read(computerPath('/api/bots/computer', bot), whole<ComputerStatusView>);
}

/** Wake it. Resolves once it runs — or with `queue_position` set when the org's slots are full. */
export function startComputer(bot?: string | null): Promise<BotsWrite<ComputerStatusView>> {
  return call(computerPath('/api/bots/computer/start', bot), jsonInit('POST'), whole<ComputerStatusView>);
}

/** A one-time, 60-second ticket for the live screen of that computer. Fetch it right before connecting. */
export function computerViewToken(bot?: string | null): Promise<BotsWrite<{ token: string; expires_at: string }>> {
  return call(
    computerPath('/api/bots/computer/view-token', bot),
    jsonInit('POST'),
    whole<{ token: string; expires_at: string }>,
  );
}

/** `ws(s)://<station>/api/ws/computer?token=…` — the ticket is the credential (no bearer token in it). */
export function computerViewerUrl(apiBase: string, token: string): string {
  const base = apiBase.replace(/\/+$/, '').replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s.toLowerCase()}://`);
  return `${base}/api/ws/computer?token=${enc(token)}`;
}

/** Take the lease: the server stops the Agent's computer actions (waking it if asleep) and forwards this member's input. */
export function takeoverComputer(bot?: string | null): Promise<BotsWrite<ComputerStatusView>> {
  return call(computerPath('/api/bots/computer/takeover', bot), jsonInit('POST'), whole<ComputerStatusView>);
}

/**
 * Give the lease back. The server settles the card it answers — `requestId`, or
 * else the single take-over / sign-in card of this computer waiting in
 * `sessionId` — and wakes the Agent that asked, with the note as context.
 * Neither → the lease is just released.
 */
export function handbackComputer(
  input: { note?: string; requestId?: string; sessionId?: string; bot?: string | null } = {},
): Promise<BotsWrite<ComputerStatusView>> {
  const note = input.note?.trim();
  return call(
    computerPath('/api/bots/computer/handback', input.bot),
    jsonInit('POST', {
      ...(note ? { note } : {}),
      ...(input.requestId ? { request_id: input.requestId } : {}),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
    }),
    whole<ComputerStatusView>,
  );
}

/**
 * Insert text into the focused field of the computer's browser (CDP insertText:
 * IME output and pasted text that raw VNC key events cannot carry). Only while
 * this member holds the lease — else 409 `lease_required`.
 */
export function typeIntoComputer(text: string, bot?: string | null): Promise<BotsWrite<void>> {
  return call(computerPath('/api/bots/computer/type', bot), jsonInit('POST', { text }), nothing);
}

/** A folder of the computer (default `~/work`; `~` = /home/agent). Directories first, ≤500 entries. Starts it if needed. */
export function listComputerFiles(path?: string, bot?: string | null): Promise<BotsRead<ComputerFileList>> {
  return read(
    computerPath(`/api/bots/computer/files${path ? `?path=${enc(path)}` : ''}`, bot),
    whole<ComputerFileList>,
  );
}

/** The download route of one file, for the shared `/file-preview` route. */
export function computerFilePath(path: string, bot?: string | null): string {
  return computerPath(`/api/bots/computer/files/download?path=${enc(path)}`, bot);
}

/** Long jobs started with `gh-jobs` (an Agent's run_background, or a terminal). Empty while it is off — never starts it. */
export function listComputerProcesses(bot?: string | null): Promise<BotsRead<ComputerProcessView[]>> {
  return read(
    computerPath('/api/bots/computer/processes', bot),
    (body) => (body as { processes: ComputerProcessView[] }).processes,
  );
}

/** The tail of a job's log (redacted by the server). */
export function computerProcessLog(
  id: string,
  lines = 200,
  bot?: string | null,
): Promise<BotsRead<ComputerProcessLog>> {
  return read(
    computerPath(`/api/bots/computer/processes/${enc(id)}/log?lines=${lines}`, bot),
    whole<ComputerProcessLog>,
  );
}

export function stopComputerProcess(id: string, bot?: string | null): Promise<BotsWrite<void>> {
  return call(computerPath(`/api/bots/computer/processes/${enc(id)}/stop`, bot), jsonInit('POST'), nothing);
}

// ─── An Agent's usage and activity (spec 20261011-agent-first-class P3d; owner only) ─

/** Its model use per day over the last `days` (≤ 90) and the totals. */
export function botUsage(botId: string, days = 30): Promise<BotsRead<BotUsageView>> {
  return read(`/api/bots/${enc(botId)}/usage?days=${days}`, whole<BotUsageView>);
}

/**
 * What it did, newest first (≤ `limit`, server cap 200): platform actions, password uses,
 * background tasks — never message content. `at` is not an `*_at` key: rewritten here.
 */
export function botActivity(botId: string, limit = 50): Promise<BotsRead<BotActivityItem[]>> {
  return read(`/api/bots/${enc(botId)}/activity?limit=${limit}`, (body) =>
    (body as { activity: BotActivityItem[] }).activity.map((item) => ({ ...item, at: isoTimestamp(item.at) })),
  );
}
