/**
 * Metering — the shared vocabulary of "who spent what on which paid service".
 *
 * Every external call a member (or a member's agent) makes through Greenhouse
 * is priced in USD micros (1 USD = 1_000_000), attributed to the member, the
 * service and the client it came from, and reserved against three monthly USD
 * budgets: the member, the service and the organization. Written by the API
 * (`apps/api/src/usage/metering.ts`), read by Administration › Services &
 * pricing and Settings › Usage.
 */

/**
 * Where a metered call came from. `gateway` is reserved for the model gateway
 * lane; `system` labels background jobs nobody is waiting on (memory upkeep).
 */
export const METERING_CLIENTS = [
  'web',
  'mobile',
  'mcp',
  'agent_api',
  'automation',
  'feishu',
  'gateway',
  'system',
] as const;
export type MeteringClient = (typeof METERING_CLIENTS)[number];

/**
 * Metered services. `llm` covers every chat-model call (priced per model in
 * models.yaml); the rest are priced in services.yaml. `computer` is reserved for
 * the cloud-computer lane.
 */
export const METERED_SERVICES = ['llm', 'vision', 'web_search', 'page_read', 'image_generation', 'computer'] as const;
export type MeteredService = (typeof METERED_SERVICES)[number];

/** What one unit of a service is. */
export const SERVICE_UNIT_KINDS = ['call', 'image', 'minute', 'token'] as const;
export type ServiceUnitKind = (typeof SERVICE_UNIT_KINDS)[number];

/** The three monthly USD budgets every metered call is reserved against. */
export type BudgetLevel = 'member' | 'service' | 'organization';

/** Fractions of a budget at which the owner (member) or the admins (service / organization) are told. */
export const BUDGET_ALERT_THRESHOLDS = [80, 100] as const;
export type BudgetAlertThreshold = (typeof BUDGET_ALERT_THRESHOLDS)[number];

// ─── Prices (read side) ──────────────────────────────────

export interface TokenPriceView {
  /** USD per 1M tokens. */
  input: number;
  output: number;
  cached_input: number | null;
}

export interface ServiceProviderPriceView {
  provider: string;
  /** Its key env var is set (or it needs none). */
  configured: boolean;
  /** USD per unit, for call / image / minute services. */
  price: number | null;
  /** Image only: USD per image by quality → size. */
  price_by_size: Record<string, Record<string, number>> | null;
  /** USD per 1M tokens. */
  token_price: TokenPriceView | null;
  /** False = 未定价: calls are recorded and cost nothing against budgets. */
  priced: boolean;
  /** Where the price comes from: a super's override, the config file, or nowhere (unpriced). */
  source: PriceSourceView;
}

export type PriceSourceView = 'override' | 'config' | null;

export interface ServicePriceView {
  service: MeteredService;
  name: string;
  unit: ServiceUnitKind;
  /** False for services reserved for a later lane (`computer`). */
  enabled: boolean;
  providers: ServiceProviderPriceView[];
}

export interface ModelPriceView {
  id: string;
  name: string;
  /** At least one provider's key is set. */
  configured: boolean;
  price: TokenPriceView | null;
  source: PriceSourceView;
}

// ─── Spend (read side) ───────────────────────────────────

export interface SpendRow {
  /** Group key: user id / service / client / OAuth client id. */
  key: string;
  /** Display name when the key is an id (member nickname, agent client name). */
  label: string | null;
  cost_usd_micros: number;
  calls: number;
  /** Calls whose cost is unknown (未定价) — counted as zero. */
  unpriced_calls: number;
}

export interface SpendTotals {
  cost_usd_micros: number;
  calls: number;
  unpriced_calls: number;
}

// ─── Budgets (read side) ─────────────────────────────────

/** Where a limit came from: an admin override, the deployment env, or the built-in default. */
export type BudgetLimitSource = 'override' | 'env' | 'default';

export interface BudgetView {
  scope: 'organization' | 'service' | 'member' | 'member_default';
  /** Service id, user id; '' for organization / member_default. */
  scope_id: string;
  label: string | null;
  limit_usd_micros: number;
  source: BudgetLimitSource;
  /** This period's balance; zero when nothing was charged yet. */
  spent_usd_micros: number;
  reserved_usd_micros: number;
}

/** `GET /api/admin/metering/overview` */
export interface MeteringOverview {
  period: { start: string; end: string };
  services: ServicePriceView[];
  models: ModelPriceView[];
  /**
   * In use (key configured, service enabled) yet unpriced: their calls count as
   * $0, so the page warns until each gets a price.
   */
  unpriced_in_use: {
    models: string[];
    services: Array<{ service: MeteredService; provider: string }>;
  };
  spend: {
    totals: SpendTotals;
    by_member: SpendRow[];
    by_service: SpendRow[];
    by_client: SpendRow[];
    /** Calls made by members' agents over MCP, by OAuth client. */
    by_agent_client: SpendRow[];
    /**
     * Charged by reservations whose outcome stayed unknown (the call started and
     * never reported back), at their estimate. Part of the budgets' spent, never
     * of the per-call facts above.
     */
    unsettled_usd_micros: number;
  };
  budgets: {
    organization: BudgetView;
    member_default: BudgetView;
    services: BudgetView[];
    /** Members with an override or with spend this period. */
    members: BudgetView[];
  };
}

/** `GET /api/usage/spend` — the caller's own month. */
export interface MySpendReport {
  period: { start: string; end: string };
  totals: SpendTotals;
  by_service: SpendRow[];
  by_client: SpendRow[];
  by_agent_client: SpendRow[];
  budget: BudgetView;
}

/**
 * `PUT /api/admin/metering/prices` — a super's price, overriding the config
 * file. A model or a token-priced service takes `input` + `output` (+ optional
 * `cached_input`), USD per 1M tokens; a call / image / minute service takes
 * `unit_price` in USD. Applies to calls settled after the change.
 */
export interface PriceOverrideInput {
  kind: 'model' | 'service';
  /** Catalog model id, or a metered service id. */
  target: string;
  /** Required for a service. */
  provider?: string;
  input?: number;
  output?: number;
  cached_input?: number | null;
  unit_price?: number;
}

/** `PUT /api/admin/metering/budgets` */
export interface BudgetLimitInput {
  scope: 'organization' | 'service' | 'member' | 'member_default';
  /** Service id or user id; omitted for organization / member_default. */
  scope_id?: string;
  limit_usd_micros: number;
}

// ─── Cloud computer (read side) ──────────────────────────

/** One member's cloud computer, as the member and the admins see it. */
export interface ComputerView {
  id: string;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed' | 'lost';
  started_at: string;
  last_used_at: string;
  stopped_at: string | null;
  stop_reason: string | null;
  /** Settled whole minutes so far. */
  minutes_billed: number;
  /** Who started it: `web`, `mcp`, … */
  client: string;
}

/** `GET /api/computer` — the caller's own computer. */
export interface MyComputerReport {
  /** The workspace switch (Services & pricing). */
  enabled: boolean;
  /** An E2B key is set. */
  configured: boolean;
  /** USD per minute at the price in force; null = unpriced. */
  price_per_minute_usd: number | null;
  idle_minutes: number;
  /** The computer holding the member's slot, if any. */
  computer: ComputerView | null;
  /** Settled minutes on computers started this UTC month. */
  minutes_this_month: number;
  period: { start: string; end: string };
}

export interface AdminComputerView extends ComputerView {
  user_id: string;
  user_label: string | null;
  oauth_client_id: string | null;
}

/** `GET /api/admin/computers` — the computers holding a slot right now. */
export interface AdminComputersReport {
  enabled: boolean;
  configured: boolean;
  max_running: number;
  idle_minutes: number;
  price_per_minute_usd: number | null;
  running: AdminComputerView[];
}
