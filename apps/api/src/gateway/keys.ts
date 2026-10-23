/**
 * Model gateway keys — issuing, viewing and revoking a member's personal keys,
 * and the workspace switch that turns the whole gateway on.
 *
 * A key is a long random secret (`ghgw_` + 32 random bytes, base64url) shown
 * once; the database keeps its SHA-256 and a short prefix
 * (`db.gatewayKeys`). Creating and revoking are platform-audited, so they show
 * in the Activity log: a member's own under "person · mcp", a super revoking
 * someone else's key under admin changes.
 */

import { randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { getModelRegistry } from '@greenhouse/agent-core';
import {
  gatewayKeyAllowedModels,
  gatewayKeyUsability,
  getUtcMonthPeriod,
  type DatabaseProvider,
  type GatewayKeySpend,
  type GatewayKeyRow,
  type GatewayKeyWithOwner,
} from '@greenhouse/db';
import {
  GATEWAY_ANTHROPIC_PATH,
  GATEWAY_KEY_SECRET_PREFIX,
  GATEWAY_OPENAI_PATH,
  type GatewayAdminKeyView,
  type GatewayKeyCreateInput,
  type GatewayKeyView,
  type GatewayModelView,
} from '@greenhouse/types/agent-access';
import type { AuthUser } from '../auth/token.js';
import { getOAuthIssuerUrl } from '../platform/oauth.js';
import { humanActor } from '../platform/actor.js';
import { PLATFORM_ORG_ID } from '../platform/runtime.js';
import { getWorkspaceFlag, getWorkspaceFlagState } from '../settings/workspace-config.js';
import type { WorkspaceFlagState } from '@greenhouse/types/workspace-settings';
import { resolveGatewayModel } from './upstream.js';

export const GATEWAY_ENABLED_SETTING = 'gateway.enabled';

/** Keys one member may hold at once (revoked and expired ones do not count). */
export const MAX_ACTIVE_GATEWAY_KEYS = 20;
const MAX_NAME_LENGTH = 80;
/** A key may be set to expire at most this far out (or never). */
const MAX_EXPIRY_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** Off unless a super (Runtime Config / Services & pricing) or `GATEWAY_ENABLED` turns it on. */
export function isGatewayEnabled(): Promise<boolean> {
  return getWorkspaceFlag(GATEWAY_ENABLED_SETTING);
}

/** The switch with its stored override and fallback, for the admin page. */
export function gatewaySwitchState(): Promise<WorkspaceFlagState> {
  return getWorkspaceFlagState(GATEWAY_ENABLED_SETTING);
}

export function gatewayBaseUrl(): string {
  return `${getOAuthIssuerUrl()}${GATEWAY_OPENAI_PATH}`;
}

export function gatewayAnthropicBaseUrl(): string {
  return `${getOAuthIssuerUrl()}${GATEWAY_ANTHROPIC_PATH}`;
}

export function generateGatewaySecret(): string {
  return `${GATEWAY_KEY_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** Catalog models the gateway can serve now on either wire, for pickers and the Connect guide. */
export function gatewayModelViews(): GatewayModelView[] {
  const registry = getModelRegistry();
  return Object.entries(registry)
    .map(([id, entry]) => ({
      id,
      name: entry.name,
      openai: resolveGatewayModel(id, entry, process.env, 'openai') !== null,
      anthropic: resolveGatewayModel(id, entry, process.env, 'anthropic') !== null,
    }))
    .filter((model) => model.openai || model.anthropic);
}

/** This UTC month's settled spend per key (llm_usage.gateway_key_id), optionally one member's keys. */
export function monthSpendByKey(db: DatabaseProvider, userId?: string): Promise<Map<string, GatewayKeySpend>> {
  const period = getUtcMonthPeriod();
  return db.gatewayKeys.spendByKey({ since: period.start, until: period.end, ...(userId ? { user_id: userId } : {}) });
}

export function toGatewayKeyView(
  row: GatewayKeyRow,
  spend?: GatewayKeySpend,
  now: number = Date.now(),
): GatewayKeyView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    allowed_models: gatewayKeyAllowedModels(row),
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    status: gatewayKeyUsability(row, now),
    month_spend_usd_micros: spend?.cost_usd_micros ?? 0,
    month_calls: spend?.calls ?? 0,
  };
}

export function toGatewayAdminKeyView(
  row: GatewayKeyWithOwner,
  spend?: GatewayKeySpend,
  now: number = Date.now(),
): GatewayAdminKeyView {
  return { ...toGatewayKeyView(row, spend, now), owner: { id: row.user_id, name: row.owner_name || row.owner_email } };
}

export type ParsedKeyInput =
  | { ok: true; name: string; allowed_models: string[] | null; expires_at: string | null }
  | { ok: false; error: string };

/** Validate a create request: a name, catalog model ids only, an expiry in the future (≤ 2 years) or none. */
export function parseGatewayKeyInput(body: Partial<GatewayKeyCreateInput> | null, now = Date.now()): ParsedKeyInput {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be a JSON object' };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { ok: false, error: 'name is required' };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, error: `name may be at most ${MAX_NAME_LENGTH} characters` };

  let allowed: string[] | null = null;
  if (body.allowed_models !== undefined && body.allowed_models !== null) {
    if (!Array.isArray(body.allowed_models) || body.allowed_models.some((id) => typeof id !== 'string')) {
      return { ok: false, error: 'allowed_models must be a list of model ids' };
    }
    const catalog = getModelRegistry();
    const unknown = body.allowed_models.filter((id) => !catalog[id]);
    if (unknown.length > 0) return { ok: false, error: `Unknown model: ${unknown.join(', ')}` };
    allowed = body.allowed_models.length > 0 ? [...new Set(body.allowed_models)] : null;
  }

  let expiresAt: string | null = null;
  if (body.expires_at !== undefined && body.expires_at !== null) {
    const at = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Number.NaN;
    if (!Number.isFinite(at)) return { ok: false, error: 'expires_at must be an ISO date-time' };
    if (at <= now) return { ok: false, error: 'expires_at must be in the future' };
    if (at - now > MAX_EXPIRY_MS) return { ok: false, error: 'expires_at may be at most two years ahead' };
    expiresAt = new Date(at).toISOString();
  }
  return { ok: true, name, allowed_models: allowed, expires_at: expiresAt };
}

/** Platform audit of a key change; the Activity log names the key by its name, never its secret. */
export async function recordGatewayKeyAudit(
  db: DatabaseProvider,
  c: Context,
  user: AuthUser,
  input: {
    actionId: 'createGatewayKey' | 'revokeGatewayKey' | 'revokeMemberGatewayKey';
    key: GatewayKeyRow;
    capability: string;
    detail?: string;
  },
): Promise<void> {
  await db.platform.recordAudit({
    orgId: PLATFORM_ORG_ID,
    actorId: user.id,
    actorType: 'human',
    requestId: humanActor(user, c).requestId,
    resource: { appId: 'platform', moduleId: 'gateway', entityId: 'gatewayKey', recordId: input.key.id },
    actionId: input.actionId,
    capability: input.capability,
    result: 'success',
    summary: {
      name: input.key.name,
      prefix: input.key.key_prefix,
      owner_id: input.key.user_id,
      allowed_models: gatewayKeyAllowedModels(input.key),
      expires_at: input.key.expires_at,
      ...(input.detail ? { detail: input.detail } : {}),
    },
  });
}
