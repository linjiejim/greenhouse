/**
 * Agent access — the wire shape of one external agent's write as members and
 * agents see it (apps/api/src/agent-access, Settings › Agent connections).
 */

import type { RuntimePayload } from './runtime.js';

/** Risk tier of a write: r1 own+reversible, r2 shared data, r3 delete-like. */
export type AgentWriteRisk = 'r1' | 'r2' | 'r3';

/**
 * Why a write ran: `direct` — the member's own permissions allow it; `confirmed`
 * — a delete-like write the agent sent again with confirm:true after its preview.
 */
export type AgentWriteBasis = 'direct' | 'confirmed';

export const AGENT_WRITE_BASES: readonly AgentWriteBasis[] = ['direct', 'confirmed'];

export type AgentWriteStatus = 'running' | 'executed' | 'failed' | 'outcome_unknown';

/** One recorded write (a Runtime run of kind `agent_write`). */
export interface AgentWriteView {
  /** The Runtime run id. */
  request_id: string;
  status: AgentWriteStatus;
  tool_id: string;
  action: string | null;
  risk: AgentWriteRisk;
  client_id: string;
  client_name: string;
  basis: AgentWriteBasis | null;
  /** What the write targets, named for a person (the document title), when the member may read it. */
  target_label: string | null;
  input: RuntimePayload;
  output: RuntimePayload | null;
  error: string | null;
  created_at: string;
  settled_at: string | null;
}

/** What a delete-like write returns the first time: nothing has run yet. */
export interface AgentWritePreview {
  status: 'needs_confirmation';
  tool: string;
  action: string | null;
  risk: 'r3';
  /** The document title, when the member may read it. */
  target: string | null;
  input: RuntimePayload;
  message: string;
}

// ─── Model gateway (members' agents on the team's models) ──

/** Every gateway secret starts with this, so a leaked one is recognisable. */
export const GATEWAY_KEY_SECRET_PREFIX = 'ghgw_';

/** Where the OpenAI-compatible gateway lives, relative to the server origin. */
export const GATEWAY_OPENAI_PATH = '/api/gateway/openai/v1';

export type GatewayKeyStatus = 'active' | 'revoked' | 'expired';

/** A gateway key as its owner (and an admin) sees it — never the secret. */
export interface GatewayKeyView {
  id: string;
  name: string;
  /** The first characters of the secret (`ghgw_…`). */
  prefix: string;
  /** Catalog model ids the key may use; null = every gateway model. */
  allowed_models: string[] | null;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  status: GatewayKeyStatus;
}

/** Administration › Services & pricing: every member's keys. */
export interface GatewayAdminKeyView extends GatewayKeyView {
  owner: { id: string; name: string | null };
}

/** A catalog model the gateway can serve right now. */
export interface GatewayModelView {
  id: string;
  name: string;
}

/** Settings › Agent connections › Model gateway. */
export interface GatewayOverview {
  /** The workspace switch (`gateway.enabled`); off = every gateway call is refused. */
  enabled: boolean;
  /** `<origin>/api/gateway/openai/v1` — the OpenAI base URL to configure. */
  base_url: string;
  models: GatewayModelView[];
  keys: GatewayKeyView[];
}

export interface GatewayKeyCreateInput {
  name: string;
  /** Catalog model ids; omitted / null / empty = every gateway model. */
  allowed_models?: string[] | null;
  /** ISO time; omitted / null = never expires. */
  expires_at?: string | null;
}

/** The only response that carries the secret: shown once, never stored. */
export interface GatewayKeyCreated {
  key: GatewayKeyView;
  secret: string;
}
