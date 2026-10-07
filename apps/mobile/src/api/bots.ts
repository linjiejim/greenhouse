/**
 * Bots API — the member's Bots, their conversations, background tasks and the
 * "needs you" requests (`/api/bots*`; endpoint table in
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
  BotConversationDetail,
  BotConversationSummary,
  BotMessage,
  BotRequestDecision,
  BotRequestStatus,
  BotRequestView,
  BotTaskView,
  BotView,
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

/** Active + archived Bots, the computer runtime, the vault flag and the pending-card count. */
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

// ─── Conversations ───────────────────────────────────────

/** Newest activity first, at most 100, no paging. */
export function listConversations(): Promise<BotsRead<BotConversationSummary[]>> {
  return read('/api/bots/conversations', (body) => (body as { conversations: BotConversationSummary[] }).conversations);
}

/** One id → that Bot's DM (created if needed); 2–6 → a new group. */
export function createConversation(input: {
  bot_ids: string[];
  title?: string;
}): Promise<BotsWrite<BotConversationDetail>> {
  return call('/api/bots/conversations', jsonInit('POST', input), conversationOf);
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

/** DMs cannot change `title` / `lead_bot_id` (400). */
export function updateConversation(
  sessionId: string,
  patch: { title?: string | null; description?: string; lead_bot_id?: string; allow_bot_chat?: boolean },
): Promise<BotsWrite<BotConversationDetail>> {
  return call(`/api/bots/conversations/${enc(sessionId)}`, jsonInit('PATCH', patch), conversationOf);
}

/** Invite a Bot (a guest in a DM). 409 `already_member`, 400 `member_limit`. */
export function addConversationMember(sessionId: string, botId: string): Promise<BotsWrite<BotConversationDetail>> {
  return call(`/api/bots/conversations/${enc(sessionId)}/members`, jsonInit('POST', { bot_id: botId }), conversationOf);
}

/** A DM's owner cannot be removed (400 `cannot_remove_owner`). */
export function removeConversationMember(sessionId: string, botId: string): Promise<BotsWrite<BotConversationDetail>> {
  return call(`/api/bots/conversations/${enc(sessionId)}/members/${enc(botId)}`, jsonInit('DELETE'), conversationOf);
}

/** Mark read (best effort — callers ignore a failure). */
export async function markConversationRead(sessionId: string): Promise<boolean> {
  const result = await call(`/api/bots/conversations/${enc(sessionId)}/read`, jsonInit('POST'), nothing);
  return result.ok;
}

function conversationOf(body: unknown): BotConversationDetail {
  return (body as { conversation: BotConversationDetail }).conversation;
}

// ─── Background tasks ────────────────────────────────────

export function listConversationTasks(sessionId: string): Promise<BotsRead<BotTaskView[]>> {
  return read(`/api/bots/conversations/${enc(sessionId)}/tasks`, (body) => (body as { tasks: BotTaskView[] }).tasks);
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
