/**
 * Vendored subset of @greenhouse/types (packages/types/src/api.ts is canonical).
 *
 * The mobile app is intentionally kept OUT of the pnpm workspace (see
 * pnpm-workspace.yaml) so its React-Native / React-19 dependency graph can't
 * pollute the web/api packages' shared store. The price is that it can't
 * import `@greenhouse/types` as a workspace package, so the handful of shapes
 * it needs are mirrored here.
 *
 * When the server-side types change, update this file to match. A CI parity
 * check (packages/contract asserting these shapes against the canonical types)
 * is a known follow-up — see apps/mobile/AGENTS.md.
 */

// ─── Auth ────────────────────────────────────────────────

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

// ─── Sessions ────────────────────────────────────────────

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
  /** Whether this session was shared with the authenticated user by someone else. */
  shared?: boolean;
  /** Share count — how many people/team can see this session. -1 = team-wide. */
  share_count?: number;
  group_id?: number | null;
  group_sort?: number;
  pinned?: boolean;
  pin_sort?: number;
  /** Inline session tags returned by the list endpoint. */
  tags?: SessionTag[];
}

export interface SessionTag {
  id: number;
  name: string;
  /** Hex color (DB default #6B7280). Always present on API responses. */
  color: string;
  /** Ordering within the tag library; present on the full row, omitted on the inline session copy. */
  sort_order?: number;
}

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

export interface SessionUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalReasoningTokens: number;
  totalDurationMs: number;
  messageCount: number;
}

// ─── Profiles ────────────────────────────────────────────

export interface ProfileCapability {
  icon: string;
  label: string;
  prompt: string;
}

export interface Profile {
  id: string;
  name: string;
  description?: string | null;
  model?: { provider: string; model: string };
  /** Registry models the user may switch between for this profile (empty = pinned). */
  model_choices?: Array<{ id: string; label: string; description?: string }>;
  tools: string[];
  system_prompt?: string;
  capabilities?: ProfileCapability[];
  greeting?: string | null;
  is_custom?: boolean;
}

// ─── Upload ──────────────────────────────────────────────

export interface UploadResult {
  id: string;
  url: string;
  mime_type: string;
  size: number;
}

// ─── Knowledge base (read-only on mobile) ────────────────

export interface KnowledgeDoc {
  id: number;
  slug: string;
  title: string;
  content_markdown: string;
  content_json: string;
  summary: string;
  questions: string;
  topics: string;
  /** JSON-encoded string[] */
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

// ─── Streaming events ────────────────────────────────────

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
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
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
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
}
export interface TitleEvent {
  type: 'title';
  title: string;
}
export interface SourceEvent {
  type: 'source';
  [key: string]: unknown;
}
export interface LocalToolRequestEvent {
  type: 'local-tool-request';
  toolCallId: string;
  toolId: string;
  params: Record<string, unknown>;
}

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

/** Dispatch a single streaming event to the appropriate callback. */
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
      cbs.onSource?.(event as unknown as Record<string, unknown>);
      break;
    case 'local-tool-request':
      cbs.onLocalToolRequest?.(event.toolCallId, event.toolId, event.params);
      break;
  }
}
