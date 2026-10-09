/**
 * Session & message type definitions — shared across DB and API layers.
 *
 * These are DB row types and input contracts. Moved here from api/session.ts
 * to eliminate the upward dependency (db/ → api/).
 */

// ─── Session Types ───────────────────────────────────────

export type SessionChannel =
  | 'web'
  | 'api'
  | 'a2a'
  | 'task'
  | 'subagent'
  | 'workflow'
  | 'mission'
  | 'feishu'
  | 'browser'
  | 'bots';

/**
 * Conversations started from the browser extension side panel. The only
 * channel a client may ask for on POST /api/sessions (every other value is
 * server-assigned), and the one the chat route keys its read-only tool face on
 * (`filterBrowserSessionToolIds` in apps/api/src/agent-runtime/tool-resolution.ts).
 */
export const BROWSER_SESSION_CHANNEL = 'browser' satisfies SessionChannel;

/**
 * Bots conversations (docs/specs/20261005-personal-assistant-bots.md). Server-
 * assigned only; owner-only on every path; listed through /api/bots, never in
 * the generic session lists.
 */
export const BOTS_SESSION_CHANNEL = 'bots' satisfies SessionChannel;

/**
 * Channels the generic session lists, title search and `session_query list`
 * hide by default: engine-internal workflow node sessions, and Bots
 * conversations, which have their own surface and a multi-speaker transcript
 * the single-agent conversation UI cannot render.
 */
export const HIDDEN_SESSION_CHANNELS: readonly SessionChannel[] = ['workflow', 'bots'];

/**
 * A Bot's background task runs in a `subagent` child session whose id starts
 * with this prefix — the one marker that tells a Bot task from a
 * `spawn_session` child everywhere (Runtime driver, notifications, lists).
 */
export const BOT_TASK_SESSION_PREFIX = 'bottask-';

/** Bots conversations and their task transcripts never inherit super/share access. */
export function isOwnerOnlySession(session: { id: string; channel: string }): boolean {
  return session.channel === BOTS_SESSION_CHANNEL || session.id.startsWith(BOT_TASK_SESSION_PREFIX);
}

/**
 * Session id prefixes the same default lists hide: a Bot's background task
 * belongs to its Bots conversation (it is reported there), not to the member's
 * Chat history.
 */
export const HIDDEN_SESSION_ID_PREFIXES: readonly string[] = [BOT_TASK_SESSION_PREFIX];

/**
 * The hide-by-default filter of the generic session lists (GET /api/sessions,
 * title search, `session_query list`): nothing hidden once the caller asks for
 * a channel explicitly. One helper so the copies cannot drift apart.
 */
export function defaultSessionListHiding(channel?: string | null): {
  excludeChannels?: SessionChannel[];
  excludeIdPrefixes?: readonly string[];
} {
  return channel
    ? {}
    : { excludeChannels: [...HIDDEN_SESSION_CHANNELS], excludeIdPrefixes: HIDDEN_SESSION_ID_PREFIXES };
}

/**
 * Was a session run as one of these agent references — exactly, or as a pinned
 * version of one (`<ref>@<v>`)? Never as a longer id: `bot:bot_1` does not match
 * `bot:bot_12`. The in-memory twin of the session list's `profileRefs` SQL filter
 * (packages/db `sessions.list`), for rows a route fetches one by one.
 */
export function matchesProfileRefs(profileId: string, refs: readonly string[]): boolean {
  return refs.some((ref) => profileId === ref || profileId.startsWith(`${ref}@`));
}

export interface SessionRow {
  id: string;
  title: string | null;
  status: string;
  rating: number | null;
  comment: string | null;
  feedback: string | null;
  profile_id: string;
  user_id: string | null;
  app_id: string | null;
  channel: SessionChannel;
  /** Set when this session was spawned by another session (spawn_session tool). */
  parent_session_id: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

// ─── Message Types ───────────────────────────────────────

export interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  references_: string;
  pipeline: string;
  reasoning: string | null;
  /** Registry model id that produced this assistant turn; null for user turns and pre-2026-08 messages. */
  model: string | null;
  /** Bot that authored this turn in a Bots conversation; null/absent everywhere else. */
  bot_id?: string | null;
  /** Structured Bots system event (JSON text), see `BotEvent` in @greenhouse/types/bots. */
  bot_event?: string | null;
  images: string;
  confidence: number | null;
  grounded: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  duration_ms: number | null;
  created_at: string;
  seq: number;
}

/** Cursor-paginated session transcript page, ordered by ascending message sequence. */
export interface SessionMessagePage {
  messages: MessageRow[];
  has_more: boolean;
  /** Exclusive cursor for the next older page, or null when the transcript start is reached. */
  next_before_seq: number | null;
}

export interface PipelineStep {
  step: number;
  tool: string;
  input: unknown;
  output: unknown;
  duration_ms: number;
}

export interface Reference {
  slug: string;
  title: string;
  type: 'kb_doc' | 'wiki' | 'source';
  /** In-app link to the referenced record (`#/knowledge/doc/<id>-<slug>`), when known. */
  url?: string;
  category?: string;
  page_type?: string;
  relevance?: number;
  /** For source references: the original source document ID */
  source_id?: string;
  /** Source references attached to this wiki page (from ref_docs) */
  ref_docs?: Array<{ source_id: string; category: string; title: string }>;
}

export interface MessageInput {
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  references?: Reference[];
  pipeline?: PipelineStep[];
  reasoning?: string;
  /** Registry model id that produced this assistant turn. */
  model?: string;
  /** Authoring Bot (Bots conversations only). */
  bot_id?: string;
  /** Structured Bots system event, serialised. */
  bot_event?: string;
  images?: Array<{ id: string; url: string }>;
  confidence?: number;
  grounded?: boolean;
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
  duration_ms?: number;
}
