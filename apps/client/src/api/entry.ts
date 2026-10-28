/**
 * The entry pages' calls (app/activate, app/oauth-consent, app/connectors/oauth-finish, the
 * sign-in providers and account bindings):
 *
 * - password links: public `POST /api/auth/password-link/inspect` (never consumes the link);
 *   completing it signs in through `signInWith` (src/api/auth.ts) with `PASSWORD_LINK_COMPLETE`;
 * - MCP OAuth consent: `GET` / `POST /api/oauth/authorization` as the signed-in member, with the
 *   authorization request passed through unchanged (PKCE included);
 * - identity providers: public `startPath` for sign-in; `<path>/oauth/start`, `<path>/binding`
 *   (signed in) for account bindings (apps/api/src/auth/identity-providers.ts).
 *
 * No answer here carries a credential; tokens never go into a URL this client builds.
 */

import { getApiBase } from '../store/stations';
import { del, get, networkMiss, post, toResult, type ApiResult } from './client';

export interface PasswordLink {
  purpose: 'invite' | 'reset';
  masked_email: string;
  expires_at: string;
}

export const PASSWORD_LINK_COMPLETE = '/api/auth/password-link/complete';

async function publicCall<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  try {
    return await toResult<T>(await fetch(`${getApiBase()}${path}`, init));
  } catch (error) {
    return networkMiss(error);
  }
}

export const inspectPasswordLink = (token: string) =>
  publicCall<PasswordLink>('/api/auth/password-link/inspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

export interface ConsentRequest {
  client: { id: string; name: string };
  redirect_uri: string;
  resource: string;
  scopes: string[];
  state: string;
}

export const readConsent = (request: Record<string, string>) =>
  get<ConsentRequest>('/api/oauth/authorization', request);

/** `granted` narrows an approval to what the member ticked; the server refuses more than asked. */
export const decideConsent = (request: Record<string, string>, decision: 'approve' | 'deny', granted?: string[]) =>
  post<{ redirect_to: string }>('/api/oauth/authorization', {
    ...request,
    decision,
    ...(granted ? { granted_scopes: granted } : {}),
  });

/** A provider's sign-in page (public; it mints a single-use state, so only on a click). */
export const startProviderSignIn = (startPath: string) => publicCall<{ authorize_url: string }>(startPath);

export interface ProviderBinding {
  available: boolean;
  binding: { provider_user_id: string; provider_name: string | null; bound_at: string } | null;
}

export const readBinding = (path: string) => get<ProviderBinding>(`${path}/binding`);
export const startBinding = (path: string) => get<{ authorize_url: string }>(`${path}/oauth/start`);
export const removeBinding = (path: string) => del<{ ok: boolean }>(`${path}/binding`);
