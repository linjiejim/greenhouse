/**
 * Team context for members' agents (v1.7): what the MCP server hands an agent
 * at the start of a task (conventions, glossary, skills, data sources), the
 * monthly retro, the data catalog and the connect wizard's "seen" check.
 *
 * Wire shapes only — the server side lives in apps/api/src/hub-context and
 * apps/api/src/retro.
 */

import type { AgentAvatar } from './agent-avatar.js';

import type { TableBaseRole } from './tables.js';

/** MCP resources a member's agent can read for team context. */
export const TEAM_CONTEXT_URIS = {
  overview: 'greenhouse://context/overview',
  conventions: 'greenhouse://context/conventions',
  glossary: 'greenhouse://context/glossary',
} as const;

/** Protocol-level MCP tools (listed for every grant, content filtered by it). */
export const TEAM_CONTEXT_TOOL = 'team_context';
export const DATA_CATALOG_TOOL = 'data_catalog';

/** At most this many convention documents. */
export const MAX_CONVENTION_DOCS = 10;

/** Default IANA zone for "workspace time" when none is configured. */
export const DEFAULT_WORKSPACE_TIMEZONE = 'Asia/Shanghai';

// ─── Admin settings (Administration › Team context) ──────

/** Why a picked document no longer serves as team context. */
export type TeamContextDocProblem = 'missing' | 'not_team' | 'archived';

export interface TeamContextDocRef {
  doc_id: string;
  title: string | null;
  /** Null when the document still serves; otherwise why it is skipped. */
  problem: TeamContextDocProblem | null;
}

export interface TeamContextCandidate {
  doc_id: string;
  title: string;
}

export interface TeamContextSettingsView {
  conventions: TeamContextDocRef[];
  glossary: TeamContextDocRef | null;
  /** The configured zone, or null for the default. */
  timezone: string | null;
  /** The zone in effect (configured, else the default). */
  effective_timezone: string;
  /** Published team documents an admin may pick (newest first, capped). */
  candidates: TeamContextCandidate[];
  /** When the monthly retro runs next (09:00 on the 1st, workspace time). */
  retro_next_run_at: string | null;
}

export interface TeamContextSettingsInput {
  conventions: string[];
  glossary: string | null;
  /** Null clears it (back to the default). Omit to leave it unchanged. */
  timezone?: string | null;
}

// ─── Data catalog ────────────────────────────────────────

/** How a member's agent reaches a source: an MCP tool (and the action to use). */
export interface DataCatalogReach {
  tool: string;
  access: 'read' | 'write';
  /** The MCP consent group the tool belongs to (`mcp:<group>`), or null for in-app only. */
  group: string | null;
  /** One line: which action / argument to use. */
  how: string;
}

export interface DataCatalogTable {
  id: string;
  name: string;
  /** Live records; null when the member may not read this base's records (counts are then left out). */
  row_count: number | null;
  /** Latest record change (only when records are readable), else the table's own update. */
  last_changed_at: string | null;
}

export interface DataCatalogBase {
  kind: 'tables_base';
  id: string;
  name: string;
  description: string | null;
  visibility: 'private' | 'team';
  /** The member's role in the base. */
  role: TableBaseRole;
  owner: { id: string; name: string } | null;
  last_changed_at: string | null;
  /** The first tables of the base (capped); `table_count` is all of them. */
  tables: DataCatalogTable[];
  table_count: number;
  /** True when `tables` stops short of `table_count`. */
  tables_truncated: boolean;
  url: string;
  reach: DataCatalogReach[];
}

export interface DataCatalogExtensionSource {
  kind: 'extension';
  /** Extension id. */
  id: string;
  name: string;
  description: string | null;
  /** Record kinds it registers in global search (`ext:<id>:<name>`). */
  record_kinds: string[];
  /** Whole-dataset exports it registers for `export_data`. */
  exports: Array<{ type: string; describe: string }>;
  reach: DataCatalogReach[];
}

export interface DataCatalog {
  generated_at: string;
  bases: DataCatalogBase[];
  extensions: DataCatalogExtensionSource[];
  /** True when the base list was cut at the cap. */
  truncated: boolean;
}

// ─── Connect wizard ──────────────────────────────────────

export const AGENT_CLIENT_KINDS = ['codex', 'claude-code', 'cursor', 'other'] as const;
export type AgentClientKind = (typeof AGENT_CLIENT_KINDS)[number];

/** One OAuth client the member connected, and when it last called the MCP server. */
export interface AgentConnectionSeen {
  client_id: string;
  client_name: string;
  kind: AgentClientKind;
  /** Last MCP request with one of its tokens; null = connected but never called. */
  last_seen_at: string | null;
  connected_at: string;
  /** Plant avatar the member picked; null = the default for its client (`kind`). */
  avatar: AgentAvatar | null;
}

export interface AgentConnectionsCheck {
  now: string;
  connections: AgentConnectionSeen[];
}

// ─── Monthly retro ───────────────────────────────────────

export type RetroSuggestionsSkipReason = 'over_budget' | 'no_model' | 'failed';

export interface RetroResult {
  /** `YYYY-MM` (UTC month the aggregates cover). */
  month: string;
  doc_id: string;
  /** Knowledge deeplink of the doc. */
  url: string;
  /** False when an earlier run's doc was updated (a new version). */
  created: boolean;
  suggestions: 'included' | 'skipped';
  skipped_reason: RetroSuggestionsSkipReason | null;
}
