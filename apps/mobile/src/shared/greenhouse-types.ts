/**
 * The server shapes this app reads, hand-kept from the v1 API (apps/api/src/routes/*). apps/mobile
 * cannot import workspace packages (see apps/mobile/AGENTS.md), so the wire types it needs live
 * here. Declarations marked "verbatim" are checked against packages/types by
 * ./vendor.parity.test.ts; the rest mirror route handlers and change with them.
 */

// ─── auth (/api/auth/*) ─────────────────────────────────────────────

export type MemberRole = 'super' | 'team';

/** `user` in the login / refresh answers (routes/auth.ts `issueUserSession`). */
export interface SessionUser {
  id: string;
  email: string;
  nickname: string;
  role: MemberRole;
  monthly_token_limit: number;
  locale: string;
}

/** `POST /api/auth/login`, `POST /api/auth/refresh`. */
export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}

/** `GET /api/auth/me` → `{ user }`: the signed-in member. */
export interface Me extends SessionUser {
  notes: string | null;
  /** Resolved per-user feature flags (`memory`, `tables`, …). */
  features: Record<string, boolean>;
}

/** `PUT /api/auth/me/preferences`. */
export interface MePreferences {
  notes: string | null;
  locale: string;
}

/** The v1 error envelope: `{ error: '<words for people>' }`. */
export interface ErrorBody {
  error?: string;
}

// ─── workspace (/api/bootstrap, public) ─────────────────────────────

/** Pre-sign-in branding plus the mobile API level (routes/bootstrap.ts). */
export interface Bootstrap {
  product_name: string | null;
  /** A data URL (or null). */
  logo: string | null;
  theme_tokens: Record<string, string> | null;
  /** The level of the API the phone app relies on; absent on servers before mobile push. */
  mobile_api?: number;
}

// ─── notifications (/api/notifications) ─────────────────────────────

/** verbatim */
export type PlatformNotificationKind =
  | 'runtime_attention'
  | 'runtime_completed'
  | 'runtime_failed'
  /** Historical only: the Agent governance worker that produced these was removed in v1.4. */
  | 'agent_review_due'
  | 'agent_suspended'
  | 'budget_attention'
  | 'system';

/** `payload` is any JSON (`RuntimeJsonValue` on the server). */
export interface PlatformNotification {
  id: string;
  user_id: string;
  kind: PlatformNotificationKind;
  title: string;
  body: string;
  payload: unknown;
  run_id: string | null;
  interrupt_id: string | null;
  event_id: string | null;
  agent_id: string | null;
  read_at: string | null;
  created_at: string;
}

/** verbatim */
export interface PlatformNotificationList {
  notifications: PlatformNotification[];
  next_cursor: string | null;
}

/** verbatim */
export interface PlatformNotificationSummary {
  unread: number;
}

// ─── knowledge (/api/knowledge) ─────────────────────────────────────

export type KbAccess = 'owner' | 'editor' | 'reader';

/** A document as `docToApi` answers it (routes/knowledge.ts). */
export interface KbDoc {
  id: number;
  slug: string;
  title: string;
  content_markdown: string;
  summary: string;
  tags: string;
  folder_id: number | null;
  visibility: 'team' | 'private';
  status: 'draft' | 'published' | 'archived';
  owner_user_id: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  access?: KbAccess;
}

/** `GET /api/knowledge/search` hits. */
export interface KbSearchHit {
  id: number;
  slug: string;
  title: string;
  summary: string;
  snippet: string;
  scope: 'team' | 'personal' | 'shared';
}

export interface KbComment {
  id: number;
  author_user_id: string;
  author_nickname: string;
  content: string;
  created_at: string;
  can_delete: boolean;
}

// ─── drive: the knowledge cabinet (/api/drive, scope kb) ────────────

export interface DriveFolder {
  id: number;
  parent_id: number | null;
  name: string;
  visibility: 'team' | 'private' | null;
  sort_order?: number;
  created_at: string;
  updated_at: string;
}

export interface DriveFile {
  id: number;
  folder_id: number | null;
  name: string;
  content_type: string | null;
  size: number;
  status?: 'pending' | 'active' | 'deleted';
  visibility: 'team' | 'private' | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

/** `POST /api/drive/files/init`: a presigned PUT (`cos`) or the API itself (`proxy`). */
export interface DriveUploadInit {
  file_id: number;
  mode: 'cos' | 'proxy';
  upload_url: string;
  complete_url?: string;
}

// ─── projects (/api/projects, routes/projects.ts) ───────────────────

export type ProjectStatus = 'planning' | 'active' | 'on_hold' | 'completed' | 'archived';
export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface TaskStats {
  total: number;
  todo: number;
  in_progress: number;
  in_review: number;
  done: number;
  cancelled: number;
}

export interface Project {
  id: number;
  title: string;
  description: string | null;
  status: ProjectStatus;
  priority: TaskPriority;
  owner_id: string;
  owner_nickname?: string | null;
  start_date: string | null;
  end_date: string | null;
  color: string | null;
  visibility?: 'public' | 'private';
  created_at: string;
  updated_at: string;
  stats?: TaskStats;
  progress?: number;
}

/** A task as the project routes answer it; `tags` / `dependencies` may be raw JSON strings. */
export interface ProjectTask {
  id: number;
  project_id: number;
  parent_id: number | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  task_type?: string;
  assignee_id: string | null;
  assignee_nickname?: string | null;
  start_date: string | null;
  due_date: string | null;
  completed_at: string | null;
  sort_order: number;
  estimated_hours: number | null;
  tags?: string[] | string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  children?: ProjectTask[];
}

export interface ProjectMember {
  id: number;
  project_id: number;
  user_id: string;
  role: 'owner' | 'member';
  nickname: string | null;
}

/** `GET /api/projects/:id`. */
export interface ProjectDetail {
  project: Project;
  tasks: ProjectTask[];
  stats: TaskStats;
  progress: number;
  members: ProjectMember[];
}

export interface TaskComment {
  id: number;
  task_id: number;
  user_id: string;
  content: string;
  created_at: string;
  user_nickname?: string | null;
}

// ─── tables (/api/tables, routes/tables.ts; feature `tables`) ───────

export type TableRole = 'owner' | 'builder' | 'editor' | 'viewer';

export interface TableBase {
  id: number;
  name: string;
  description: string | null;
  visibility: 'private' | 'team';
  owner_id: string;
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
  role?: TableRole;
}

export interface TableDef {
  id: number;
  base_id: number;
  name: string;
  description: string | null;
  position: number;
  schema_revision: number;
  archived_at: string | null;
}

export type TableFieldType =
  | 'text'
  | 'long_text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'single_select'
  | 'multi_select'
  | 'user'
  | 'multi_user'
  | 'url'
  | 'email'
  | 'phone'
  | 'attachment'
  | 'relation'
  | 'formula'
  | 'rollup';

export interface TableField {
  id: number;
  table_id: number;
  name: string;
  type: TableFieldType | string;
  required: boolean;
  is_primary: boolean;
  /** JSON text (`{ options: [{ id, label, color? }] }` for selects). */
  config: string | null;
  position: number;
  archived_at: string | null;
}

export interface TableRecord {
  id: number;
  table_id: number;
  /** Keyed by field id as a string. */
  values: Record<string, unknown>;
  computed_values?: Record<string, unknown> | null;
  revision: number;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TableSchema {
  table: TableDef;
  fields: TableField[];
}

export interface TableRecordPage {
  records: TableRecord[];
  total: number;
  nextCursor: string | null;
}

export interface TableUser {
  id: string;
  nickname: string | null;
}

// ─── agent access, spend and the model gateway (1.6) ────────────────

export type AgentWriteStatus = 'running' | 'executed' | 'failed' | 'outcome_unknown';

/** `GET /api/agent-access/writes` → `{ writes }` (the caller's own, newest first, at most 50). */
export interface AgentWrite {
  request_id: string;
  status: AgentWriteStatus;
  tool_id: string;
  action: string | null;
  risk: 'r1' | 'r2' | 'r3';
  client_id: string;
  client_name: string;
  basis: 'direct' | 'confirmed' | null;
  target_label: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  created_at: string;
  settled_at: string | null;
}

export interface SpendRow {
  key: string;
  label: string | null;
  cost_usd_micros: number;
  calls: number;
  unpriced_calls: number;
}

/** `GET /api/usage/spend` (the caller's own; integer USD micros). */
export interface MySpend {
  period: { start: string; end: string };
  totals: { cost_usd_micros: number; calls: number; unpriced_calls: number };
  by_service: SpendRow[];
  by_client: SpendRow[];
  by_agent_client?: SpendRow[];
  budget: { limit_usd_micros: number; spent_usd_micros: number; reserved_usd_micros: number; source: string };
}

export interface GatewayKey {
  id: string;
  name: string;
  prefix: string;
  allowed_models: string[] | null;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  status: 'active' | 'revoked' | 'expired';
  month_spend_usd_micros: number;
  month_calls: number;
}

/** `GET /api/agent-access/gateway`; never carries a key's secret. */
export interface GatewayOverview {
  enabled: boolean;
  base_url: string | null;
  keys: GatewayKey[];
}

// ─── assistant chat (/api/sessions, /api/chat) ──────────────────────

export interface ChatSession {
  id: string;
  title: string | null;
  status: string;
  profile_id: string | null;
  created_at: string;
  updated_at: string;
  is_owner?: boolean;
  pinned?: boolean;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | string;
  content: string;
  seq: number;
  created_at: string;
}
