/**
 * Model gateway API — the member's own gateway keys (Settings › Agent
 * connections › Model gateway) and every member's keys for a super
 * (Administration › Services & pricing). The secret only ever comes back from
 * `createGatewayKey`, once. See apps/api/src/routes/agent-access.ts and
 * admin-metering.ts.
 */

import type {
  GatewayAdminKeyView,
  GatewayKeyCreateInput,
  GatewayKeyCreated,
  GatewayOverview,
} from '@greenhouse/types/agent-access';
import { rpc } from './client';

function errorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object' || !('error' in value)) return fallback;
  return typeof value.error === 'string' ? value.error : fallback;
}

export async function fetchGatewayOverview(): Promise<GatewayOverview> {
  const response = await rpc.api['agent-access'].gateway.$get();
  const data = await response.json();
  if (!response.ok) throw new Error(errorMessage(data, `Unable to load the model gateway (${response.status})`));
  return data;
}

export async function createGatewayKey(input: GatewayKeyCreateInput): Promise<GatewayKeyCreated> {
  // Non-literal arg: hc only types `json` for validator-backed routes.
  const args = { json: input };
  const response = await rpc.api['agent-access'].gateway.keys.$post(args);
  const data = await response.json();
  if (!response.ok || !('secret' in data)) {
    throw new Error(errorMessage(data, `Unable to create the key (${response.status})`));
  }
  return data;
}

export async function revokeGatewayKey(id: string): Promise<void> {
  const response = await rpc.api['agent-access'].gateway.keys[':id'].$delete({ param: { id } });
  if (!response.ok) {
    const data = await response.json().catch(() => undefined);
    throw new Error(errorMessage(data, `Unable to revoke the key (${response.status})`));
  }
}

export async function fetchAllGatewayKeys(): Promise<{ enabled: boolean; keys: GatewayAdminKeyView[] }> {
  const response = await rpc.api.admin.metering['gateway-keys'].$get();
  const data = await response.json();
  if (!response.ok) throw new Error(errorMessage(data, `Unable to load gateway keys (${response.status})`));
  return data;
}

export async function revokeMemberGatewayKey(id: string): Promise<void> {
  const response = await rpc.api.admin.metering['gateway-keys'][':id'].$delete({ param: { id } });
  if (!response.ok) {
    const data = await response.json().catch(() => undefined);
    throw new Error(errorMessage(data, `Unable to revoke the key (${response.status})`));
  }
}
