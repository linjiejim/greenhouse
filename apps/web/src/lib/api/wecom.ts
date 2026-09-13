/**
 * WeCom binding client.
 *
 * Stays on raw authFetch rather than hc: the callback leg is a browser redirect
 * the typed client has no notion of, and these three calls are not worth a
 * validator-backed route just to type them.
 */

import { authFetch } from '../auth';

export interface WeComBindingState {
  /** False when the deployment has no WeCom app configured — hide the UI entirely. */
  available: boolean;
  binding: { provider_user_id: string; provider_name: string | null; bound_at: string } | null;
}

export async function fetchWeComBinding(): Promise<WeComBindingState> {
  try {
    const res = await authFetch('/api/wecom/binding');
    if (!res.ok) return { available: false, binding: null };
    return (await res.json()) as WeComBindingState;
  } catch {
    // Treated as "not available": a binding card that cannot read its own state
    // is worse than no card.
    return { available: false, binding: null };
  }
}

/**
 * Begin authorization.
 *
 * Returns the consent URL for the browser to navigate to itself — this call
 * must carry the Bearer token (it is how the server knows who is binding), and
 * a full-page navigation cannot send headers.
 */
export async function startWeComBinding(): Promise<string> {
  const res = await authFetch('/api/wecom/oauth/start');
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Failed to start WeCom binding: ${res.status}`);
  }
  return ((await res.json()) as { authorize_url: string }).authorize_url;
}

export async function unbindWeCom(): Promise<void> {
  const res = await authFetch('/api/wecom/binding', { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to unbind WeCom: ${res.status}`);
}
