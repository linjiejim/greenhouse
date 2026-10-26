/**
 * Feishu sign-in from the app. React-free decisions (./feishu.test.ts) plus the system auth
 * session: the station says whether Feishu sign-in is configured (`/api/feishu/login-available`,
 * public), `start-login?app_redirect=` mints a state that returns to the app's own address only
 * (the server allow-lists exactly `FEISHU_APP_REDIRECT`), and the one-shot code that comes back
 * is exchanged for a session (../api/auth.ts `loginWithFeishuCode`).
 */

/** The app's return address — plugins/feishu/api/oauth.ts `APP_LOGIN_REDIRECT`. */
export const FEISHU_APP_REDIRECT = 'greenhouse://auth/feishu';

export type FeishuReturn = { kind: 'code'; code: string } | { kind: 'error'; reason: string } | { kind: 'cancel' };

/** The URL the auth session ended on → what it says. Anything not ours is a cancel. */
export function parseFeishuReturn(url: string | null | undefined): FeishuReturn {
  if (!url || !url.startsWith(`${FEISHU_APP_REDIRECT}?`)) return { kind: 'cancel' };
  const params = new URLSearchParams(url.slice(FEISHU_APP_REDIRECT.length + 1));
  const code = params.get('feishu_code');
  if (code && /^[A-Za-z0-9_-]{16,256}$/.test(code)) return { kind: 'code', code };
  if (params.get('feishu') === 'error') return { kind: 'error', reason: params.get('reason') || 'unknown' };
  return { kind: 'cancel' };
}

/** The member-facing reason key for a failed Feishu sign-in. */
export function feishuErrorKey(reason: string): 'login.feishuNotBound' | 'login.feishuDisabled' | 'login.feishuFailed' {
  if (reason === 'not_bound') return 'login.feishuNotBound';
  if (reason === 'account_inactive') return 'login.feishuDisabled';
  return 'login.feishuFailed';
}
