/**
 * API response type definitions — shared across Web, Mobile, and any future client.
 *
 * These types describe the shape of data returned by the backend HTTP API.
 * They are intentionally separate from DB row types (which may include
 * internal fields like user_id, app_id, channel that are not exposed to clients).
 *
 * Convention:
 * - DB row types live in types/session.ts, types/eval.ts, db/interfaces.ts
 * - API response types (what the client sees) live here
 * - Some types are intentionally identical to DB rows — that's fine,
 *   it gives us freedom to diverge without breaking clients.
 */

// ─── Profile Types ───────────────────────────────────────

export interface ProfileCapability {
  icon: string;
  label: string;
  prompt: string;
}

export interface Profile {
  id: string;
  name: string;
  description?: string | null;
  // Custom profiles derive model from their base profile — absent if the base is gone.
  model?: { provider: string; model: string };
  // Registry models the user may switch between for this profile (empty = pinned).
  model_choices?: Array<{ id: string; label: string; description?: string }>;
  tools: string[];
  max_steps?: number;
  tool_choice?: string;
  system_prompt?: string;
  capabilities?: ProfileCapability[];
  usage?: ProfileUsage | null;
  // Custom profile fields
  is_custom?: boolean;
  is_shared?: boolean;
  base_profile_id?: string;
  user_id?: string;
  slug?: string;
  forked_from?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ProfileUsage {
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_reasoning_tokens: number;
  avg_duration_ms: number;
  last_used_at: string | null;
}

export interface ProfileDetail {
  profile: Profile;
  usage: {
    total: {
      calls: number;
      input_tokens: number;
      output_tokens: number;
      cached_tokens: number;
      reasoning_tokens: number;
      avg_duration_ms: number;
      last_used_at: string | null;
    } | null;
    last_24h: { calls: number; input_tokens: number; output_tokens: number } | null;
    last_7d: { calls: number; input_tokens: number; output_tokens: number } | null;
  };
  recent_calls: Array<{
    id: number;
    profile_id: string;
    caller: string;
    session_id?: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cached_tokens?: number;
    reasoning_tokens?: number;
    duration_ms?: number;
    created_at: string;
  }>;
}

export interface UsageSummary {
  by_profile: Array<{
    profile_id: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    avg_duration_ms: number;
    last_used_at: string | null;
  }>;
  by_caller: Array<{ caller: string; calls: number; input_tokens: number; output_tokens: number }>;
  total: {
    total_calls: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cached_tokens: number;
    total_reasoning_tokens: number;
  };
  period: { since: string | null };
}

// ─── Session Types (API response shape) ──────────────────

/**
 * Session as returned by the API — a subset of SessionRow,
 * excluding internal fields (user_id, app_id, channel).
 */
export interface Session {
  id: string;
  title: string | null;
  status: string;
  rating: number | null;
  comment: string | null;
  feedback: string | null;
  profile_id: string;
  channel?: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  /** Whether the authenticated user owns this session. */
  is_owner?: boolean;
  /** Whether this session was shared with the authenticated user by someone else (list endpoint). */
  shared?: boolean;
  /** Share count — how many people/team can see this session. -1 = team-wide. */
  share_count?: number;
  /** The current user's custom folder for this session (per-user; null = unfiled). */
  group_id?: number | null;
  /** Sort order within that folder. */
  group_sort?: number;
  /** Whether the current user has pinned this session. */
  pinned?: boolean;
  /** Sort order within the current user's Pinned group. */
  pin_sort?: number;
}

/**
 * Session group (folder) as returned by the API. The built-in Pinned group
 * has kind='pinned'; user folders have kind='custom'.
 */
export interface SessionGroup {
  id: number;
  name: string;
  color: string;
  icon: string | null;
  kind: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  /** Number of sessions filed in this group (when the API includes counts). */
  member_count?: number;
}

/**
 * Message as returned by the API — identical to MessageRow.
 */
export interface Message {
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

/**
 * Aggregated token usage for a session.
 */
export interface SessionUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalReasoningTokens: number;
  totalDurationMs: number;
  messageCount: number;
}

// ─── Upload Types ────────────────────────────────────────

export interface UploadResult {
  id: string;
  url: string;
  mime_type: string;
  size: number;
}

// ─── Team Knowledge Base Types ───────────────────────────

export interface KnowledgeDoc {
  id: number;
  slug: string;
  title: string;
  content_markdown: string;
  content_json: string;
  summary: string;
  questions: string;
  topics: string;
  tags: string;
  space: string;
  visibility: 'team' | 'private';
  status: 'draft' | 'published' | 'archived';
  owner_user_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** The current viewer's effective role on this doc (when the API resolved it). */
  access?: 'owner' | 'editor' | 'reader' | null;
}

export interface KnowledgeShare {
  /** user id, or 'group:<id>' for a group grant. */
  target: string;
  kind: 'user' | 'group';
  name: string;
  role: 'reader' | 'editor';
}

export interface UserGroup {
  id: number;
  name: string;
  description: string;
  created_by: string;
  member_count?: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface GroupMember {
  user_id: string;
  nickname: string;
  email?: string;
  added_at: string | null;
}

export interface KnowledgeDocVersion {
  id: number;
  doc_id: number;
  version: number;
  title: string;
  content_markdown: string;
  content_json: string;
  summary: string;
  changed_by: string | null;
  change_reason: string | null;
  created_at: string | null;
}

export interface KnowledgeSearchResult {
  id: number;
  slug: string;
  title: string;
  summary: string;
  snippet: string;
  tags: string;
  relevance: number;
}

export interface KnowledgeGenerateResult {
  title: string;
  slug: string;
  content_markdown: string;
  summary: string;
  questions: string[];
  topics: string[];
  tags: string[];
}

export interface ChangeProposal {
  slug: string;
  title: string;
  reason: string;
  changes: Array<{
    field: string;
    description: string;
    before: string;
    before_full?: string;
    after: string;
  }>;
  affected_pages?: string[];
}

export interface ApplyResult {
  success: boolean;
  slug: string;
  changelog_id: number | null;
  changed_by: string;
  reason: string;
  fields_updated: string[];
}

// ─── Feature Request Types ───────────────────────────────

export interface FeatureRequest {
  id: number;
  title: string;
  description: string;
  submitted_by: string;
  /** Enriched on the list endpoint only — PATCH /:id returns the bare row. */
  submitted_by_nickname?: string;
  submitted_by_role?: string;
  status: 'pending' | 'accepted' | 'rejected' | 'done';
  priority: 'low' | 'normal' | 'high';
  admin_note: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

// ─── User & Usage Types ──────────────────────────────────

export interface UserUsageSummary {
  user_id: string;
  nickname: string;
  role: string;
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  last_used_at: string | null;
}

export interface ShareableUser {
  id: string;
  nickname: string;
  email: string;
  role: string;
}

// ─── User Prompt Types ───────────────────────────────────

export interface UserPrompt {
  id: number;
  user_id: string;
  title: string;
  content: string;
  shortcut: string | null;
  sort_order: number;
  is_global: boolean;
  created_at: string;
  updated_at: string;
}

// ─── Share Types ─────────────────────────────────────────

export interface ShareItem {
  id: number;
  session_id: string;
  shared_with: string;
  shared_by: string;
  message: string | null;
  read_at: string | null;
  created_at: string;
  /** Present on GET /api/shares (inbox); NOT returned by GET /api/sessions/:id/shares. */
  session_title?: string;
  shared_by_nickname: string;
  /** Present on GET /api/sessions/:id/shares only. */
  shared_with_nickname?: string;
  /** Per-user read timestamp (replaces read_at for correctness). */
  user_read_at?: string | null;
}

/** Share context returned in session detail for non-owner viewers. */
export interface ShareInfo {
  shared_by: string;
  shared_by_nickname: string;
  message: string | null;
  created_at: string;
  total_viewers: number; // -1 = team-wide
}

// ─── Session Tag Types ───────────────────────────────────

export interface SessionTag {
  id: number;
  name: string;
  color: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// ─── Auth Types ──────────────────────────────────────────

export type UserRole = 'super' | 'team' | 'external';

export interface AuthenticatedUser {
  id: string;
  email?: string;
  nickname: string;
  role: UserRole;
  profiles: string[];
  daily_message_limit?: number;
  monthly_token_limit?: number;
  notes?: string | null;
  locale?: string;
  /** Feature flags enabled for this user (e.g. { memory: true }). */
  features?: Record<string, boolean>;
}

// ─── Client Action Types ─────────────────────────────────

/**
 * A frontend action the client advertises to the agent for the current turn.
 *
 * The client (web/mobile) declares which UI actions are available on the current
 * screen — navigate, prefill a form, read the current view, etc. The backend turns
 * each into an agent tool whose execution round-trips back to the client (reusing the
 * same `local-tool-request` → POST `/api/desktop/tool-result` bridge as desktop local
 * tools). Only the serializable descriptor crosses the wire; the live `execute` handler
 * stays in the client.
 */
export interface ClientActionDescriptor {
  /** Tool name the agent calls, e.g. 'navigate'. Must be unique per turn. */
  name: string;
  /** When the agent should use it + what it does. Becomes the tool description. */
  description: string;
  /** JSON Schema (object) describing the action's parameters. */
  parameters: Record<string, unknown>;
}

// ─── Streaming Types ─────────────────────────────────────

export interface TextDeltaEvent {
  type: 'text-delta';
  text: string;
}

export interface ReasoningDeltaEvent {
  type: 'reasoning-delta';
  text: string;
}

export interface ToolCallStartEvent {
  type: 'tool-call-start';
  id: string;
  toolName: string;
}

export interface ToolCallDeltaEvent {
  type: 'tool-call-delta';
  id: string;
  delta: string;
}

export interface ToolCallEndEvent {
  type: 'tool-call-end';
  id: string;
}

export interface ToolCallEvent {
  type: 'tool-call';
  id?: string;
  toolName: string;
  input: unknown;
}

export interface ToolResultEvent {
  type: 'tool-result';
  id: string;
  toolName: string;
  output: unknown;
}

export interface SessionEvent {
  type: 'session';
  session_id: string;
}

export interface FinishEvent {
  type: 'finish';
  finishReason?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };
}

export interface ErrorEvent {
  type: 'error';
  error: string;
}

export interface StepStartEvent {
  type: 'step-start';
}

export interface StepFinishEvent {
  type: 'step-finish';
  finishReason?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };
}

export interface TitleEvent {
  type: 'title';
  title: string;
}

export interface SourceEvent {
  type: 'source';
  [key: string]: unknown;
}

/** Desktop-only: request frontend to execute a local tool via the desktop bridge. */
export interface LocalToolRequestEvent {
  type: 'local-tool-request';
  toolCallId: string;
  toolId: string;
  params: Record<string, unknown>;
}

/** Discriminated union of all stream event types. */
export type StreamingEvent =
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | ToolCallEvent
  | ToolResultEvent
  | SessionEvent
  | FinishEvent
  | ErrorEvent
  | StepStartEvent
  | StepFinishEvent
  | TitleEvent
  | SourceEvent
  | LocalToolRequestEvent;

// ─── Stream Event Callbacks ──────────────────────────────

export interface StreamEventCallbacks {
  onTextDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
  onToolCallStart?: (id: string, toolName: string) => void;
  onToolCallDelta?: (id: string, delta: string) => void;
  onToolCallEnd?: (id: string) => void;
  onToolCall?: (toolName: string, input: unknown, id?: string) => void;
  onToolResult?: (id: string, toolName: string, output: unknown) => void;
  onSession?: (sessionId: string) => void;
  onFinish?: (finishReason?: string, usage?: FinishEvent['usage']) => void;
  onError?: (error: string) => void;
  onStepStart?: () => void;
  onStepFinish?: (finishReason?: string, usage?: FinishEvent['usage']) => void;
  onTitle?: (title: string) => void;
  onSource?: (data: Record<string, unknown>) => void;
  onLocalToolRequest?: (toolCallId: string, toolId: string, params: Record<string, unknown>) => void;
}

// ─── Cost Estimation ─────────────────────────────────────

// Prices in USD per 1M tokens (illustrative default — adjust for your model)
const PRICING = {
  inputCacheHit: 0.0028,
  inputCacheMiss: 0.14,
  output: 0.28,
};

const USD_TO_CNY = 7.2;

export function estimateCost(usage: {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
}): { usd: number; cny: number } {
  const cached = usage.cachedTokens || 0;
  const totalInput = usage.inputTokens || 0;
  const uncached = Math.max(0, totalInput - cached);
  const output = usage.outputTokens || 0;

  const usd =
    (cached * PRICING.inputCacheHit + uncached * PRICING.inputCacheMiss + output * PRICING.output) / 1_000_000;
  return { usd, cny: usd * USD_TO_CNY };
}

// ─── Formatting Utilities ────────────────────────────────

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

export function formatDuration(ms: number): string {
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return ms + 'ms';
}

// ─── Stream Event Dispatcher ─────────────────────────────

/**
 * Dispatch a single streaming event to the appropriate callback.
 * Platform-agnostic — works in both Web and React Native.
 */
export function handleStreamEvent(event: StreamingEvent, cbs: StreamEventCallbacks): void {
  switch (event.type) {
    case 'text-delta':
      cbs.onTextDelta?.(event.text);
      break;
    case 'reasoning-delta':
      cbs.onReasoningDelta?.(event.text);
      break;
    case 'tool-call-start':
      cbs.onToolCallStart?.(event.id, event.toolName);
      break;
    case 'tool-call-delta':
      cbs.onToolCallDelta?.(event.id, event.delta);
      break;
    case 'tool-call-end':
      cbs.onToolCallEnd?.(event.id);
      break;
    case 'tool-call':
      cbs.onToolCall?.(event.toolName, event.input, event.id);
      break;
    case 'tool-result':
      cbs.onToolResult?.(event.id, event.toolName, event.output);
      break;
    case 'session':
      cbs.onSession?.(event.session_id);
      break;
    case 'finish':
      cbs.onFinish?.(event.finishReason, event.usage);
      break;
    case 'error':
      cbs.onError?.(event.error);
      break;
    case 'step-start':
      cbs.onStepStart?.();
      break;
    case 'step-finish':
      cbs.onStepFinish?.(event.finishReason, event.usage);
      break;
    case 'title':
      cbs.onTitle?.(event.title);
      break;
    case 'source':
      cbs.onSource?.(event as Record<string, unknown>);
      break;
    case 'local-tool-request':
      cbs.onLocalToolRequest?.(event.toolCallId, event.toolId, event.params);
      break;
  }
}

// ─── Scheduled Tasks ─────────────────────────────────────

export interface ScheduledTask {
  id: number;
  name: string;
  profile_id: string;
  task_prompt: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  max_steps: number;
  last_run_at: string | null;
  last_status: string | null;
  next_run_at: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

export interface ScheduledTaskInput {
  name: string;
  profile_id?: string;
  task_prompt: string;
  schedule: string;
  timezone?: string;
  max_steps?: number;
  enabled?: boolean;
}

export interface TaskRunSummary {
  session_id: string;
  title: string | null;
  status: string;
  created_at: string;
  message_count?: number;
}

// ─── NDJSON Stream Reader ────────────────────────────────

/**
 * Read a ReadableStream line-by-line, parse each line as JSON.
 * Platform-agnostic — uses ReadableStreamDefaultReader (available in Web and RN).
 */
export async function* readNdjsonStream<T>(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<T> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) {
        try {
          yield JSON.parse(line);
        } catch (_err) {
          /* skip malformed lines */
        }
      }
    }
  }
  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer);
    } catch (_err) {
      /* skip */
    }
  }
}
