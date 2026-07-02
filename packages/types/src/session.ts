/**
 * Session & message type definitions — shared across DB and API layers.
 *
 * These are DB row types and input contracts. Moved here from api/session.ts
 * to eliminate the upward dependency (db/ → api/).
 */

// ─── Session Types ───────────────────────────────────────

export type SessionChannel = 'web' | 'api' | 'a2a' | 'task' | 'subagent' | 'browser';

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
  /** Knowledge-base document citation. */
  type: 'wiki';
  category?: string;
  page_type?: string;
  relevance?: number;
  /** Knowledge-base document id (knowledge_base.doc_id) — used to open the doc. */
  doc_id?: string;
}

export interface MessageInput {
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  references?: Reference[];
  pipeline?: PipelineStep[];
  reasoning?: string;
  images?: Array<{ id: string; url: string }>;
  confidence?: number;
  grounded?: boolean;
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
  duration_ms?: number;
}
