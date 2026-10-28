/**
 * Feishu identity glue (plugins/feishu/api/oauth.ts). Browser sign-in starts at `start-login`
 * without an app address, so Feishu returns to the client's `/login#feishu_code=` (a one-shot,
 * sixty-second code) or `/login#feishu=error&reason=`; binding returns to `/bindings?feishu=`.
 * The phone's sign-in (greenhouse://auth/feishu) stays in src/login/feishu.ts.
 */

import type { IdentityGlue } from '../identity';
import { feishuErrorKey } from '../../login/feishu';

const AUTO_LATCH = 'greenhouse_feishu_auto_login_attempted';

/** Inside the Feishu (Lark) app the sign-in page goes straight to Feishu, once per tab. */
function autoStartOnce(): boolean {
  if (typeof navigator === 'undefined' || !/Lark|Feishu/i.test(navigator.userAgent ?? '')) return false;
  try {
    // An unbound account comes back with an error: the latch keeps it from bouncing forever.
    if (sessionStorage.getItem(AUTO_LATCH) === '1') return false;
    sessionStorage.setItem(AUTO_LATCH, '1');
    return true;
  } catch {
    // No storage: never redirect on our own (a loop would be worse than one click).
    return false;
  }
}

export const identity: IdentityGlue = {
  id: 'feishu',
  title: 'entry.providers.feishu',
  path: '/api/feishu',
  login: {
    startPath: '/api/feishu/oauth/start-login',
    exchangePath: '/api/feishu/oauth/exchange',
    read(params) {
      const code = params.get('feishu_code');
      if (code && /^[A-Za-z0-9_-]{16,256}$/.test(code)) return { kind: 'code', code };
      if (params.get('feishu') === 'error') return { kind: 'error', reason: (params.get('reason') || 'unknown').slice(0, 64) };
      return null;
    },
    errorKey: feishuErrorKey,
    autoStart: autoStartOnce,
  },
};
