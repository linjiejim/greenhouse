/**
 * Feishu binding + scan-login client.
 *
 * Stays on raw fetch/authFetch rather than hc, same as the WeCom sibling: the
 * callback leg is a browser redirect the typed client has no notion of, and
 * the login pair runs before any Bearer token exists.
 */

import { authFetch, storeAuthenticatedSession, type AuthenticatedUser } from '../auth';
import { apiUrl } from '../api-base';

export interface FeishuBindingState {
  /** False when the deployment has no Feishu app configured — hide the UI entirely. */
  available: boolean;
  binding: { provider_user_id: string; provider_name: string | null; bound_at: string } | null;
}

export async function fetchFeishuBinding(): Promise<FeishuBindingState> {
  try {
    const res = await authFetch('/api/feishu/binding');
    if (!res.ok) return { available: false, binding: null };
    return (await res.json()) as FeishuBindingState;
  } catch {
    // Treated as "not available": a binding card that cannot read its own state
    // is worse than no card.
    return { available: false, binding: null };
  }
}

/**
 * Begin binding authorization.
 *
 * Returns the consent URL for the browser to navigate to itself — this call
 * must carry the Bearer token (it is how the server knows who is binding), and
 * a full-page navigation cannot send headers.
 */
export async function startFeishuBinding(): Promise<string> {
  const res = await authFetch('/api/feishu/oauth/start');
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Failed to start Feishu binding: ${res.status}`);
  }
  return ((await res.json()) as { authorize_url: string }).authorize_url;
}

export async function unbindFeishu(): Promise<void> {
  const res = await authFetch('/api/feishu/binding', { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to unbind Feishu: ${res.status}`);
}

// ─── Login (pre-auth, plain fetch) ───────────────────────

/**
 * Whether the deployment offers Feishu login at all.
 *
 * Read-only on purpose — probing `start-login` instead would mint a pending
 * authorization state on every login-page load, including the password logins
 * that never touch Feishu.
 */
export async function probeFeishuLogin(): Promise<boolean> {
  try {
    const res = await fetch(apiUrl('/api/feishu/login-available'));
    if (!res.ok) return false;
    return ((await res.json()) as { available?: boolean }).available === true;
  } catch {
    return false;
  }
}

/**
 * Are we running inside the Feishu client (workspace web app, or a Greenhouse
 * link opened in Feishu)? UA sniffing is the documented signal — both the
 * Chinese (`Lark`) and international (`Feishu`) clients tag themselves.
 *
 * Used only to decide whether to *offer* silent login; it grants nothing on its
 * own, and a false positive costs one redirect the user can back out of.
 */
export function isInsideFeishuClient(): boolean {
  return /Lark|Feishu/i.test(navigator.userAgent);
}

const AUTO_LOGIN_LATCH = 'greenhouse_feishu_auto_login_attempted';

/** Auto-login fires once per tab — an unbound account must not loop forever. */
export function feishuAutoLoginAttempted(): boolean {
  try {
    return sessionStorage.getItem(AUTO_LOGIN_LATCH) === '1';
  } catch {
    // Private mode / storage disabled: treat as "already tried" so the worst
    // case is a normal login form rather than a redirect loop.
    return true;
  }
}

export function markFeishuAutoLoginAttempted(): void {
  try {
    sessionStorage.setItem(AUTO_LOGIN_LATCH, '1');
  } catch {
    /* nothing to do — the getter already fails closed */
  }
}

/** Begin login authorization — mints the state, so only call it on click. */
export async function startFeishuLogin(): Promise<{ ok: boolean; url?: string; error?: string }> {
  try {
    const res = await fetch(apiUrl('/api/feishu/oauth/start-login'));
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error };
    }
    const body = (await res.json()) as { authorize_url: string };
    return { ok: true, url: body.authorize_url };
  } catch {
    return { ok: false };
  }
}

/**
 * Exchange the one-shot login code (from the callback redirect) for a normal
 * session. On success the session is stored exactly like a password login.
 */
export async function exchangeFeishuLoginCode(
  code: string,
): Promise<{ ok: boolean; user?: AuthenticatedUser; error?: string }> {
  try {
    const res = await fetch(apiUrl('/api/feishu/oauth/exchange'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      accessToken?: string;
      refreshToken?: string;
      user?: AuthenticatedUser;
    };
    if (!res.ok || !data.accessToken || !data.user) {
      return { ok: false, error: data.error };
    }
    storeAuthenticatedSession(data.accessToken, data.refreshToken ?? '', data.user);
    return { ok: true, user: data.user };
  } catch {
    return { ok: false };
  }
}
