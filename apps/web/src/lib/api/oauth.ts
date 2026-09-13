/**
 * Platform OAuth API — consent and the current user's agent connections.
 */

import { rpc } from './client';

function errorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object' || !('error' in value)) return fallback;
  return typeof value.error === 'string' ? value.error : fallback;
}

export async function validateOAuthAuthorization(params: URLSearchParams) {
  const args = { query: Object.fromEntries(params) };
  const response = await rpc.api.oauth.authorization.$get(args);
  const data = await response.json();
  if (!response.ok) throw new Error(errorMessage(data, `Authorization request failed (${response.status})`));
  return data;
}

/**
 * @param grantedScopes - what the user actually ticked. Omitted approves the
 *   whole request; the server still refuses a selection with no resource group.
 */
export async function decideOAuthAuthorization(
  params: URLSearchParams,
  decision: 'approve' | 'deny',
  grantedScopes?: string[],
): Promise<string> {
  const json = {
    ...Object.fromEntries(params),
    decision,
    ...(grantedScopes ? { granted_scopes: grantedScopes } : {}),
  };
  const response = await rpc.api.oauth.authorization.$post({ json });
  const data = await response.json();
  if (!response.ok) throw new Error(errorMessage(data, `Authorization decision failed (${response.status})`));
  if (!('redirect_to' in data) || typeof data.redirect_to !== 'string') {
    throw new Error('Authorization server returned an invalid redirect');
  }
  return data.redirect_to;
}

export async function fetchOAuthGrants() {
  const response = await rpc.api.oauth.grants.$get();
  const data = await response.json();
  if (!response.ok) throw new Error(errorMessage(data, `Unable to load agent connections (${response.status})`));
  if (!('grants' in data)) throw new Error('Agent connections response is missing grants');
  return data.grants;
}

export type OAuthGrant = Awaited<ReturnType<typeof fetchOAuthGrants>>[number];

export async function revokeOAuthGrant(id: string): Promise<void> {
  const response = await rpc.api.oauth.grants[':id'].$delete({ param: { id } });
  if (!response.ok) {
    const data = await response.json().catch(() => undefined);
    throw new Error(errorMessage(data, `Unable to revoke agent connection (${response.status})`));
  }
}
