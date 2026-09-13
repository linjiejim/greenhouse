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

/**
 * A piece of display text available in more than one language.
 *
 * System profiles (YAML) can declare per-locale copy; custom profiles (user-authored,
 * stored in DB) never do. Clients therefore always keep the flat field as the fallback:
 * `current locale → source locale ('zh') → flat field`.
 */
export type LocalizedText = Partial<Record<'en' | 'zh', string>>;

export interface ProfileAvatar {
  color?: string;
  accessories?: string[];
  leafStyle?: 'normal' | 'big' | 'mini' | 'double';
  eyeStyle?: 'classic' | 'dot' | 'soft' | 'focused';
  faceStyle?: string;
}

export interface Profile {
  id: string;
  name: string;
  description?: string | null;
  /** Per-locale copy for `name` — system profiles only. */
  name_i18n?: LocalizedText;
  /** Per-locale copy for `description` — system profiles only. */
  description_i18n?: LocalizedText;
  // Resolved provider/model, for display only.
  model?: { provider: string; model: string };
  /** Registry model id this agent is pinned to (v3: one agent = one model). */
  model_id?: string;
  tools: string[];
  max_steps?: number;
  tool_choice?: string;
  system_prompt?: string;
  usage?: ProfileUsage | null;
  // Custom profile fields
  is_custom?: boolean;
  is_shared?: boolean;
  base_profile_id?: string;
  user_id?: string;
  /** Present when the custom Agent belongs to another internal user. */
  owner_nickname?: string;
  slug?: string;
  forked_from?: string | null;
  avatar?: ProfileAvatar;
  created_at?: string;
  updated_at?: string;
  /** Stable asset lifecycle and immutable executable version metadata. */
  lifecycle_status?: 'draft' | 'review' | 'pilot' | 'verified' | 'rejected' | 'suspended' | 'deprecated' | 'archived';
  lifecycle_note?: string | null;
  current_version?: number;
  published_version?: number | null;
  manifest_hash?: string;
  change_log?: string;
  purpose?: string | null;
  audience?: string | null;
  risk_level?: 'low' | 'medium' | 'high';
  budget_policy?: Record<string, unknown>;
  eval_refs?: unknown[];
  owner_backup_user_id?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  next_review_at?: string | null;
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
 * Which slice of the conversation list a caller wants.
 *
 * - `mine`   — sessions the caller owns (every role, super included)
 * - `shared` — sessions someone else shared with the caller
 * - `team`   — everyone else's sessions; super only, 403 otherwise
 *
 * Omitting the scope keeps the legacy combined list (super sees everything).
 */
export const SESSION_SCOPES = ['mine', 'shared', 'team'] as const;
export type SessionScope = (typeof SESSION_SCOPES)[number];

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
  /** Set when the session was spawned by another one (spawn_session, workflow nodes). */
  parent_session_id?: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  /** Whether the authenticated user owns this session. */
  is_owner?: boolean;
  /** Whether this session was shared with the authenticated user by someone else (list endpoint). */
  shared?: boolean;
  /** Display name of the owner — present on list rows the caller does not own. */
  owner_nickname?: string;
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
  /** Registry model id that produced this assistant turn; null for user turns. */
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

// ─── Message Eval Types ──────────────────────────────────

export interface MessageEvalResult {
  exists: boolean;
  eval?: {
    id: number;
    message_id: string;
    session_id: string;
    /** v2 verdict — 'pass' | 'fail' | 'pending'. Null on legacy rows. */
    verdict?: string | null;
    score_accuracy: number | null;
    score_faithfulness: number | null;
    score_completeness: number | null;
    score_hallucination: number | null;
    score_final: number | null;
    /** JSON array string; nullable in DB (column default '[]' without NOT NULL). */
    discrepancies: string | null;
    duration_ms: number | null;
    created_at: string;
  };
  agent_session_id?: string | null;
}

/** One evaluated message's latest-run summary — from GET /sessions/:id/evals. */
export interface SessionEvalSummary {
  message_id: string;
  /** 'pass' | 'fail' | 'pending'; null on legacy rows. */
  verdict: string | null;
  /** Weighted 0–10; null when verdict is 'pending'. */
  score_final: number | null;
  /** The Agent session that ran the eval — used to restore it on click. */
  eval_session_id: string | null;
  created_at: string;
}

// ─── Upload Types ────────────────────────────────────────

export interface UploadResult {
  id: string;
  url: string;
  mime_type: string;
  size: number;
}

// ─── Wiki Types ──────────────────────────────────────────

export interface WikiPage {
  slug: string;
  category: string;
  title: string;
  content?: string;
  summary: string;
  questions: string;
  topics: string;
  tags: string;
  meta: string;
  created_at: string;
  updated_at: string;
}

export interface WikiCategory {
  name: string;
  count: number;
}

/** Matches the server's SourceSearchResult (GET /api/wiki/search → results[]). */
export interface WikiSearchResult {
  source_id: string;
  category: string;
  title: string;
  _slug: string | null;
  _summary: string | null;
  snippet: string;
  relevance: number;
}

// ─── Team Knowledge Base Types ───────────────────────────

/**
 * A unified knowledge search hit (GET /api/knowledge/search). `slug` is the
 * doc_id — feed it to the stable `#/knowledge/doc/<id>-<slug>` deeplink. `scope`
 * + `access` say which channel matched and the caller's effective role.
 */
export interface KnowledgeSearchHit {
  id: number;
  slug: string;
  title: string;
  summary: string;
  snippet: string;
  tags: string;
  relevance: number;
  scope: 'team' | 'personal' | 'shared';
  access: 'owner' | 'editor' | 'reader';
}

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
  /** kb drive folder this doc lives in (null = root). */
  folder_id: number | null;
  /** Manual order among siblings in the sidebar tree; 0 = never dragged (alphabetical). */
  sort_order: number;
  /** Whether this doc is a reusable template ("new from template"). */
  is_template: boolean;
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

/** A doc that links TO the current doc (backlink), access-filtered. */
export interface KnowledgeBacklink {
  id: number;
  slug: string;
  title: string;
}

/** A document-level comment. */
export interface KnowledgeComment {
  id: number;
  author_user_id: string;
  author_nickname: string;
  content: string;
  created_at: string | null;
  can_delete: boolean;
}

/** A current editor of a doc (editing presence). */
export interface KnowledgeEditor {
  userId: string;
  nickname: string;
}

/** LWW conflict info returned by a save when the row moved on. */
export interface KnowledgeConflict {
  conflicted: true;
  updated_by: string | null;
  updated_at: string | null;
}

export interface KnowledgeTemplateSummary {
  id: number;
  slug: string;
  title: string;
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

export interface ApplyResult {
  success: boolean;
  slug: string;
  changelog_id: number | null;
  changed_by: string;
  reason: string;
  fields_updated: string[];
}

// ─── Source Types ─────────────────────────────────────────

export interface SourceItem {
  id: number;
  source_id: string;
  category: string;
  title: string;
  tags: string | null;
  meta: string | null;
  file_path: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface SourceCategory {
  name: string;
  count: number;
}

// ─── Sync Types ──────────────────────────────────────────

export interface SyncScanChange {
  source_id: string;
  category: string;
  title: string;
  change_type: 'new' | 'updated' | 'deleted';
  remote_updated_at?: string | null;
  local_updated_at?: string | null;
  remote_created_at?: string | null;
}

export interface SyncScanSummary {
  total: number;
  new: number;
  updated: number;
  deleted: number;
}

export interface SyncScanResult {
  summary: Record<string, SyncScanSummary>;
  changes: SyncScanChange[];
  scanned_at: string;
  duration_ms: number;
}

export interface SyncFieldDiff {
  field: string;
  before: string;
  after: string;
}

export interface SyncPreviewChange {
  index: number;
  source_id: string;
  category: string;
  action: 'added' | 'updated' | 'deleted';
  title: string;
  diff_summary: string;
  field_diffs?: SyncFieldDiff[];
  new_content?: string;
  old_content?: string;
  before_hash?: string;
  after_hash?: string;
  /**
   * Scan flagged it as updated (newer timestamp) but synced content is identical
   * — applying only refreshes the local updated_at so it stops reappearing.
   */
  timestamp_only?: boolean;
}

export interface SyncCategorySummary {
  added: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

export interface SyncPreviewResult {
  previewId: string;
  summary: Record<string, SyncCategorySummary>;
  changes: SyncPreviewChange[];
  errors: string[];
}

export interface SyncRun {
  id: number;
  status: string;
  categories: string[];
  trigger: string;
  started_at: string;
  finished_at: string | null;
  summary: Record<string, SyncCategorySummary>;
}

export interface SyncChange {
  id: number;
  run_id: number;
  source_id: string;
  category: string;
  action: string;
  title: string | null;
  diff_summary: string | null;
  before_hash: string | null;
  after_hash: string | null;
  created_at: string;
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

/**
 * A Task — the user-facing name for a saved, reusable prompt.
 *
 * The wire shape keeps the historical field names (and the `/api/prompts`
 * path): a task with no variables and no tools is byte-for-byte the prompt
 * this always was, so renaming the transport would only have forced every
 * client to change for nothing.
 */
export interface UserPrompt {
  id: number;
  user_id: string;
  title: string;
  content: string;
  shortcut: string | null;
  sort_order: number;
  is_global: boolean;
  description: string | null;
  /** JSON-encoded `TaskVariable[]` — parse with `parseTaskVariables`. */
  variables: string;
  /** JSON-encoded `string[]` of tool ids the captured flow used. Display only. */
  expected_tools: string;
  source_session_id: string | null;
  created_via: 'manual' | 'capture';
  created_at: string;
  updated_at: string;
  /** Present on scoped lists when the Task belongs to another user. */
  owner_nickname?: string;
}

export const PROMPT_SCOPES = ['mine', 'shared', 'team'] as const;
export type PromptScope = (typeof PROMPT_SCOPES)[number];

// ─── Share Types ─────────────────────────────────────────

export interface ShareItem {
  id: number;
  session_id: string;
  shared_with: string;
  shared_by: string;
  message: string | null;
  /** Per-user timestamp on inbox responses; omitted from share-management responses. */
  read_at?: string | null;
  created_at: string;
  /** Present on GET /api/shares (inbox); NOT returned by GET /api/sessions/:id/shares. */
  session_title?: string;
  shared_by_nickname: string;
  /** Present on GET /api/sessions/:id/shares only. */
  shared_with_nickname?: string;
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
  role: Exclude<UserRole, 'external'>;
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
 * The browser Web client declares which UI actions are available on the current
 * screen — navigate, prefill a form, read the current view, etc. The backend turns
 * each into an agent tool whose execution round-trips back to that browser through
 * the legacy `local-tool-request` event and POST `/api/client-actions/tool-result`.
 * Only the serializable descriptor crosses the wire; the live `execute` handler stays
 * in the client.
 */
export interface ClientActionDescriptor {
  /** Tool name the agent calls, e.g. 'crm_navigate'. Must be unique per turn. */
  name: string;
  /** When the agent should use it + what it does. Becomes the tool description. */
  description: string;
  /** JSON Schema (object) describing the action's parameters. */
  parameters: Record<string, unknown>;
}

/** Serializable page-scoped Client Actions captured for one chat turn. */
export interface ClientActionSnapshot {
  scopeId: string;
  actions: ClientActionDescriptor[];
}

/** Optional browser environment attached to a single chat turn. */
export interface ChatTurnEnvironment {
  ambientContext?: import('./agent-context.js').AmbientContextEnvelope;
  clientActions?: ClientActionSnapshot;
  /**
   * Model for THIS turn. Omitted by every headless caller, which keeps the
   * agent's own `model.id` — the picker beside the composer is the only thing
   * that sets it (spec: 20260731-attachment-and-preset-convergence M3).
   */
  model?: string;
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

/** Request the browser to execute a declared client action (legacy wire event name). */
export interface LocalToolRequestEvent {
  type: 'local-tool-request';
  toolCallId: string;
  toolId: string;
  params: Record<string, unknown>;
  /** Page scope that advertised the action; omitted for legacy callers. */
  scopeId?: string;
}

/**
 * Keepalive filler. Carries no information — consumers ignore it.
 *
 * A step that runs long without producing output (image generation takes ~30–100s)
 * otherwise leaves the connection silent, and any reverse proxy in the path will
 * eventually treat that silence as a dead upstream and close it mid-answer
 * (nginx's `proxy_read_timeout` defaults to 60s). Bytes on the wire reset that timer.
 */
export interface PingEvent {
  type: 'ping';
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
  | LocalToolRequestEvent
  | PingEvent;

// ─── Background Run Replay Envelope ──────────────────────

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

/** A stream event as delivered over a reconnectable run stream. */
export type ReplayableStreamEvent = StreamingEvent & RunReplayEnvelope;

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
  onLocalToolRequest?: (toolCallId: string, toolId: string, params: Record<string, unknown>, scopeId?: string) => void;
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
 * UI-framework-agnostic dispatcher used by the browser Web client.
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
      cbs.onLocalToolRequest?.(event.toolCallId, event.toolId, event.params, event.scopeId);
      break;
    case 'ping':
      // Keepalive filler — its only job was to put bytes on the wire.
      break;
  }
}

// ─── Scheduled Tasks ─────────────────────────────────────

export interface ScheduledTask {
  id: number;
  /** Owner id is required for Mine / Team administration views. */
  user_id: string;
  /** Present when a super views another user's Automation. */
  owner_nickname?: string;
  name: string;
  profile_id: string;
  task_prompt: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  max_steps: number;
  /** Optional WeCom group-bot webhook the scheduler posts run summaries to. */
  notify_webhook: string | null;
  /** Email the run summary to the owner's own account address. */
  notify_email: boolean;
  /** Deliver the run summary as a WeCom app message to the owner (recipient derived from their binding). */
  notify_wecom: boolean;
  /** Deliver the run summary as a Feishu card DM to the owner (recipient derived from their binding). */
  notify_feishu: boolean;
  /**
   * JSON string array of tools the owner granted to this automation's
   * unattended runs, beyond the read-only baseline. Catalog and parsing live in
   * `@greenhouse/types/automation-tools`; the value is a filter, never a grant.
   */
  unattended_tools: string;
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
  notify_webhook?: string | null;
  notify_email?: boolean;
  notify_wecom?: boolean;
  notify_feishu?: boolean;
}

/**
 * One past execution of an Automation. The spine is the `channel='task'`
 * session (every run, including pre-Runtime history, has one); the `run`
 * projection is attached where a durable Runtime run exists and carries
 * status, error and timing. `run: null` therefore means "legacy run from
 * before the Runtime era", not "no execution happened".
 */
export interface AutomationRunEntry {
  session_id: string;
  title: string | null;
  created_at: string;
  run: {
    id: string;
    status: string;
    trigger: 'scheduled' | 'manual';
    error_code: string | null;
    error_message: string | null;
    started_at: string | null;
    ended_at: string | null;
  } | null;
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

/**
 * Chat-specific completion guard layered on top of the generic NDJSON parser.
 *
 * A transport can reach EOF after yielding valid partial JSON lines. That is
 * not a successful chat turn unless the server explicitly emitted `finish`.
 * Keeping this separate preserves readNdjsonStream for non-chat NDJSON users.
 */
export async function* requireChatStreamFinish(events: AsyncIterable<StreamingEvent>): AsyncGenerator<StreamingEvent> {
  let sawFinish = false;
  let streamError: string | undefined;

  for await (const event of events) {
    yield event;
    if (event.type === 'error') {
      streamError = event.error || 'Chat stream failed before completion';
    }
    if (event.type === 'finish') {
      sawFinish = true;
    }
  }

  if (streamError) {
    throw new Error(streamError);
  }
  if (!sawFinish) {
    throw new Error('Chat stream ended before completion. Please retry.');
  }
}
