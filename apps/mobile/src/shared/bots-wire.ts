/**
 * Vendored wire shapes the Bots client needs beyond src/shared/bots.ts — the run-stream envelope,
 * the persisted-message parts, the web Bots API's response types and the web stream consumer's
 * per-Bot segment. Each declaration below is a verbatim copy (only `export` added where the
 * canonical one is module-private) of the canonical source named above it; the root vitest
 * (src/bots/vendor/vendor.parity.test.ts) compares them declaration by declaration. Do not edit
 * here: change the canonical declaration, re-copy it, and run that test.
 */

import type { AvatarConfig } from '../ui/plant-avatar/avatar-config';
import type {
  BotConversationDetail,
  BotMessage,
  BotTemplateKey,
  BotTurnReason,
  BotView,
  ComputerRuntimeView,
} from './bots';

// ─── packages/types/src/session.ts ───────────────────────

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

// ─── packages/types/src/api.ts ───────────────────────────

/**
 * Fields the chat run registry adds to every buffered event so a reconnecting
 * client can resume exactly where it left off.
 *
 * `seq` is the monotonic cursor a client echoes back as `?after=`; `replayed`
 * marks events served from the buffer rather than live, which lets consumers
 * skip the side-effectful ones (re-running a client action after a refresh
 * would fire it against a page instance that no longer advertised it).
 *
 * Declared here — not on either side — because the api stamps these fields and
 * the browser reads them; two local definitions would drift silently.
 */
export interface RunReplayEnvelope {
  seq?: number;
  replayed?: boolean;
}

/**
 * Lifecycle of one background chat generation. Shared so the registry, the
 * `chat:run` WebSocket event and the browser all name the same three states.
 */
export type ChatRunStatus = 'running' | 'completed' | 'error';

/** Shape of `GET /api/chat/runs/:sessionId`'s `run` field. */
export interface ChatRunInfo {
  run_id: string;
  status: ChatRunStatus;
  started_at: number;
  next_seq: number;
}

// ─── apps/web/src/lib/api/bots.ts ────────────────────────

export interface BotsOverview {
  /** Active Bots — pickers, the avatar strip and the mention list. */
  bots: BotView[];
  /**
   * Archived Bots, so an archived Bot's conversation, messages, cards and
   * audit rows still show its real name and face (read-only).
   */
  archived_bots: BotView[];
  computer: ComputerRuntimeView;
  vault_available: boolean;
  pending_requests: number;
}

export interface BotMemoryView {
  id: number;
  title: string;
  content: string;
  category: string;
  status: string;
  pinned: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface BotWriteInput {
  template_key?: BotTemplateKey;
  name?: string;
  role?: string;
  description?: string;
  instructions?: string;
  avatar?: AvatarConfig;
  model_id?: string | null;
  /** Tool ids the Bot may use; null = inherit the owner's whole allowed set. */
  tools?: string[] | null;
  max_steps?: number | null;
  change_log?: string;
}

/** One page of a conversation (`GET /api/bots/conversations/:id`), newest page unless `before_seq`. */
export interface ConversationPage {
  conversation: BotConversationDetail;
  messages: BotMessage[];
  has_more: boolean;
  /**
   * Current status of every memory a receipt on this page names (`active`,
   * `archived`, `superseded`, `deleted`…), so an undone receipt stays undone
   * after a reload. Optional: without it, undo state lasts for the tab.
   */
  memory_states?: Record<string, string>;
}

// ─── apps/web/src/lib/stream-events.ts ───────────────────

/** Tool-call state assembled by SessionManager for streaming UI components. */
export interface StreamingToolCall {
  id: string;
  name: string;
  input: string;
  output?: unknown;
  status: 'calling' | 'done';
}

// ─── apps/web/src/lib/session-manager.tsx ────────────────

/**
 * One Bot's part of a multi-speaker Bots run: everything between its
 * `bot-turn-start` and `bot-turn-end`. Text, reasoning and tool events in that
 * window belong to this Bot, never to the session-level fields.
 */
export interface BotStreamSegment {
  botId: string;
  reason: BotTurnReason;
  /** The Bot that handed over (reason `ask`). */
  askedBy?: string;
  /** `skipped`: a wrap-up turn with nothing to add — nothing persisted, nothing to show. */
  status: 'streaming' | 'completed' | 'error' | 'stopped' | 'skipped';
  text: string;
  reasoning: string;
  toolCalls: StreamingToolCall[];
  /** The persisted message, once the turn ended (dedupes against a transcript reload). */
  messageId?: string;
  error?: string;
}

/** Copy the mutable segments into a fresh snapshot so memoized consumers see the change. */
export function snapshotSegments(segments: BotStreamSegment[]): BotStreamSegment[] {
  return segments.map((segment) => ({ ...segment, toolCalls: [...segment.toolCalls] }));
}

/** Close any segment the run ended without a `bot-turn-end` for (stop, transport loss, server error). */
export function settleOpenSegments(segments: BotStreamSegment[], status: BotStreamSegment['status']): BotStreamSegment[] {
  return segments.map((segment) =>
    segment.status === 'streaming' ? { ...segment, status, toolCalls: [...segment.toolCalls] } : { ...segment },
  );
}
