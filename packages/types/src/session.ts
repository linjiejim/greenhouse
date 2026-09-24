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
  | 'browser';

/**
 * Conversations started from the browser extension side panel. The only
 * channel a client may ask for on POST /api/sessions (every other value is
 * server-assigned), and the one the chat route keys its read-only tool face on
 * (apps/api/src/chat/browser-channel.ts).
 */
export const BROWSER_SESSION_CHANNEL = 'browser' satisfies SessionChannel;

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
  images?: Array<{ id: string; url: string }>;
  confidence?: number;
  grounded?: boolean;
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
  duration_ms?: number;
}
