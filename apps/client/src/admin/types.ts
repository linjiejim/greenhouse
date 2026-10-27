/**
 * Hand-kept subset of the station's administration answers (apps/api/src/routes/admin*.ts,
 * platform-admin.ts, packages/types metering / workspace-settings / agent-access). Only the
 * fields these screens read; the station adds fields freely.
 */

// ─── Users (/api/admin/users) ────────────────────────────

export type UserStatus = 'active' | 'invited' | 'reset_required' | 'disabled';

export interface PasswordLink {
  id: string;
  purpose: string;
  expires_at: string;
  created_at: string;
  sent_at: string | null;
  delivery_status: string;
  delivery_error: string | null;
}

export interface ManagedUser {
  id: string;
  email: string;
  nickname: string;
  role: string;
  status: UserStatus | (string & {});
  created_at: string;
  last_login_at: string | null;
  usage_summary: {
    total_calls: number;
    today_messages: number;
    month_tokens: number;
    last_used_at: string | null;
  } | null;
  password_link: PasswordLink | null;
}

export type PasswordLinkCapability = { available: true } | { available: false; reason: string };

export interface ManagedUsers {
  users: ManagedUser[];
  password_link_capability: PasswordLinkCapability;
}

/** A write that may have mailed a password link. */
export interface LinkDelivery {
  delivery?: { status: 'sent' } | { status: 'failed'; error: string };
}

// ─── Access view (/api/admin/users/:id/access) ───────────

export type ReadMode = 'full' | 'masked' | 'none';
export interface AccessTool {
  id: string;
  name: string;
  brief: string;
  assigned: boolean;
}
export interface AccessEntity {
  appId: string;
  entityId: string;
  title: string;
  fields: { id: string; title: string }[];
  effectivePolicy: { scopes: string[]; fields: Record<string, { read: ReadMode; write: boolean; export: boolean }> };
}
export interface AccessFeaturePoint {
  key: string;
  title: string;
  description: string;
  icon: string;
  kind: 'app' | 'flag' | 'toolset' | (string & {});
  group: 'basic' | 'apps' | 'advanced';
  enabled: boolean;
  mainControl: { type: 'flag'; flag: string } | null;
  capabilities?: { capability: string; allowed: boolean; reason: string }[];
  entities?: AccessEntity[];
  tools?: AccessTool[];
}
export interface UserAccessView {
  featurePoints: AccessFeaturePoint[];
  baseline: { globalTools: AccessTool[] };
}

// ─── Workspace settings (/api/admin/settings) ────────────

export interface WorkspaceSettingView {
  key: string;
  group: string;
  label: string;
  description: string;
  type: 'string' | 'text' | 'json' | 'boolean';
  secret: boolean;
  env: string | null;
  value: unknown;
  has_value: boolean;
  source: 'db' | 'env' | 'none';
  flag: { effective: boolean; fallback: boolean } | null;
}

/** A boolean workspace switch as an admin sees it (`gateway.enabled`, `ext.computer…`). */
export interface WorkspaceFlagState {
  effective: boolean;
  fallback: boolean;
  override: boolean | null;
  source: 'db' | 'env' | 'default';
}

// ─── Services & pricing (/api/admin/metering) ────────────

export type ServiceUnit = 'call' | 'image' | 'minute' | 'token';
export interface TokenPrice {
  input: number;
  output: number;
  cached_input: number | null;
}
export type PriceSource = 'override' | 'config' | null;
export interface ServiceProvider {
  provider: string;
  configured: boolean;
  price: number | null;
  price_by_size: Record<string, Record<string, number>> | null;
  token_price: TokenPrice | null;
  priced: boolean;
  source: PriceSource;
}
export interface ServicePrice {
  service: string;
  name: string;
  unit: ServiceUnit;
  enabled: boolean;
  providers: ServiceProvider[];
}
export interface ModelPrice {
  id: string;
  name: string;
  configured: boolean;
  price: TokenPrice | null;
  source: PriceSource;
}
export interface SpendRow {
  key: string;
  label: string | null;
  cost_usd_micros: number;
  calls: number;
  unpriced_calls: number;
}
export type BudgetScope = 'organization' | 'service' | 'member' | 'member_default';
export interface Budget {
  scope: BudgetScope;
  scope_id: string;
  label: string | null;
  limit_usd_micros: number;
  source: 'override' | 'env' | 'default';
  spent_usd_micros: number;
  reserved_usd_micros: number;
}
export interface MeteringOverview {
  services: ServicePrice[];
  models: ModelPrice[];
  unpriced_in_use: { models: string[]; services: { service: string; provider: string }[] };
  spend: {
    totals: { cost_usd_micros: number; calls: number; unpriced_calls: number };
    by_member: SpendRow[];
    by_service: SpendRow[];
    by_client: SpendRow[];
    by_agent_client: SpendRow[];
    unsettled_usd_micros: number;
  };
  budgets: { organization: Budget; member_default: Budget; services: Budget[]; members: Budget[] };
}
export interface PriceInput {
  kind: 'model' | 'service';
  target: string;
  provider?: string;
  input?: number;
  output?: number;
  cached_input?: number | null;
  unit_price?: number;
}
export interface GatewayAdminKey {
  id: string;
  name: string;
  prefix: string;
  owner: { id: string; name: string | null };
  allowed_models: string[] | null;
  status: 'active' | 'expired' | 'revoked' | (string & {});
  month_spend_usd_micros: number;
  month_calls: number;
  last_used_at: string | null;
}
export interface GatewayAdminKeys {
  enabled: boolean;
  switch: WorkspaceFlagState;
  keys: GatewayAdminKey[];
}
