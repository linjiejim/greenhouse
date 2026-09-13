/** Public one-time account setup/password reset API. */

import type { AuthenticatedUser } from '@greenhouse/types/api';
import { apiUrl } from '../api-base';
import { storeAuthenticatedSession } from '../auth';

export interface PasswordLinkInspection {
  purpose: 'invite' | 'reset';
  masked_email: string;
  expires_at: string;
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function postPublic<T>(path: string, body: Record<string, string>): Promise<ApiResult<T>> {
  try {
    const response = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) return { ok: false, error: data.error || `Request failed (${response.status})` };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
  }
}

export function inspectPasswordLink(token: string): Promise<ApiResult<PasswordLinkInspection>> {
  return postPublic('/api/auth/password-link/inspect', { token });
}

export async function completePasswordLink(
  token: string,
  password: string,
): Promise<ApiResult<{ user: AuthenticatedUser }>> {
  const result = await postPublic<{
    accessToken: string;
    refreshToken: string;
    user: AuthenticatedUser;
  }>('/api/auth/password-link/complete', { token, password });
  if (!result.ok) return result;
  storeAuthenticatedSession(result.data.accessToken, result.data.refreshToken, result.data.user);
  return { ok: true, data: { user: result.data.user } };
}
