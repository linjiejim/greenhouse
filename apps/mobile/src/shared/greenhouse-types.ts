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
