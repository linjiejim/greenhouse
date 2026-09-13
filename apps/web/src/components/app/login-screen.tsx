/**
 * 登录界面 — 内部用户邮箱密码登录 + 飞书扫码登录（部署配置了飞书应用才显示）。
 */

import React, { useEffect, useState } from 'react';
import { AppLogo, Button, Input } from '../ui';
import { loginInternal } from '../../lib/auth';
import type { AuthenticatedUser } from '../../lib/auth';
import {
  exchangeFeishuLoginCode,
  feishuAutoLoginAttempted,
  isInsideFeishuClient,
  markFeishuAutoLoginAttempted,
  probeFeishuLogin,
  startFeishuLogin,
} from '../../lib/api/feishu';
import { useT } from '../../lib/i18n';

export function LoginScreen({ onSuccess }: { onSuccess: (user: AuthenticatedUser) => void }) {
  const t = useT();
  const taglines = [t('login.taglineSmarterWork'), t('login.taglineSharedKnowledge'), t('login.taglineTeamMomentum')];
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Feishu login: hidden unless the deployment has the app configured. The
  // mount-time probe doubles as the availability check — a button that always
  // 503s is a capability claim the product cannot honour.
  const [feishuAvailable, setFeishuAvailable] = useState(false);
  const [feishuBusy, setFeishuBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void probeFeishuLogin().then((available) => {
      if (alive && available) setFeishuAvailable(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // The Feishu callback comes back to `#/login?feishu_code=…` (one-shot 60s
  // exchange code — long-lived credentials never enter the URL) or
  // `#/login?feishu=error&reason=…`. Read once, clear the hash, act.
  useEffect(() => {
    const [hashPath, query] = window.location.hash.split('?');
    if (!query) return;
    const params = new URLSearchParams(query);
    const code = params.get('feishu_code');
    const feishuError = params.get('feishu');
    if (!code && !feishuError) return;
    window.location.hash = hashPath || '#/';

    if (code) {
      setFeishuBusy(true);
      void exchangeFeishuLoginCode(code)
        .then((result) => {
          if (result.ok && result.user) onSuccess(result.user);
          else setError(result.error || t('login.feishuFailed'));
        })
        .finally(() => setFeishuBusy(false));
      return;
    }
    const reason = params.get('reason');
    // A failed auto-login must not re-trigger itself — see the auto-login effect.
    markFeishuAutoLoginAttempted();
    setError(reason === 'not_bound' ? t('login.feishuNotBound') : t('login.feishuFailed'));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot URL read on mount
  }, []);

  /**
   * Inside the Feishu client (workspace app, or any Greenhouse link opened in
   * Feishu), go straight to authorization instead of showing a password form
   * the user has no reason to fill in. Feishu remembers the grant, so after the
   * first consent this is effectively silent.
   *
   * Two things keep this from becoming a trap:
   *  - it fires **once per tab** (sessionStorage). An unbound account lands back
   *    here with `reason=not_bound`; without the latch it would bounce straight
   *    back to Feishu and the login form would be unreachable — an infinite
   *    redirect the user cannot escape.
   *  - it is gated on `feishuAvailable`, so a deployment without Feishu (or one
   *    whose probe failed) still renders the ordinary form.
   *
   * Outside the Feishu client this effect does nothing at all — browser
   * behaviour is unchanged.
   */
  useEffect(() => {
    if (!feishuAvailable || feishuBusy) return;
    if (!isInsideFeishuClient() || feishuAutoLoginAttempted()) return;
    markFeishuAutoLoginAttempted();
    void handleFeishuLogin();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once availability is known
  }, [feishuAvailable]);

  const handleFeishuLogin = async () => {
    setFeishuBusy(true);
    setError('');
    // Fetch a fresh consent URL at click time — the mount-time probe's state
    // may have aged past its TTL while the page sat open.
    const result = await startFeishuLogin();
    if (result.ok && result.url) {
      window.location.href = result.url;
      return;
    }
    setError(result.error || t('login.feishuFailed'));
    setFeishuBusy(false);
  };

  const handleBackgroundPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * 100;
    const y = ((event.clientY - bounds.top) / bounds.height) * 100;
    event.currentTarget.style.setProperty('--auth-glow-x', `${x.toFixed(2)}%`);
    event.currentTarget.style.setProperty('--auth-glow-y', `${y.toFixed(2)}%`);
  };

  const resetBackgroundGlow = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.style.setProperty('--auth-glow-x', '50%');
    event.currentTarget.style.setProperty('--auth-glow-y', '34%');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setLoading(true);
    setError('');

    if (!email.trim()) {
      setError(t('login.emailRequired'));
      setLoading(false);
      return;
    }
    // `finally` rather than clearing after the await: anything that throws in here
    // would otherwise leave the button stuck on "Signing in…" with no message, which
    // is exactly what a network failure used to do.
    try {
      const result = await loginInternal(email.trim(), password.trim());
      if (result.ok && result.user) {
        onSuccess(result.user);
      } else {
        setError(result.error || t('login.loginFailed'));
        setPassword('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.loginFailed'));
      setPassword('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="brand-auth-background app-viewport overflow-y-auto flex items-center justify-center px-4 py-[max(1rem,env(safe-area-inset-top))]"
      onPointerMove={handleBackgroundPointerMove}
      onPointerLeave={resetBackgroundGlow}
      data-tauri-drag-region
    >
      <form
        onSubmit={handleSubmit}
        className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-edge bg-surface-raised p-6 shadow-xl shadow-primary-900/10 md:p-8 dark:shadow-black/30"
      >
        <div className="brand-gradient absolute inset-x-0 top-0 h-1" aria-hidden="true" />
        <div className="text-center mb-6">
          <div className="mx-auto flex w-fit justify-center rounded-2xl bg-logo-safe p-2">
            <AppLogo size="xl" logoOnly />
          </div>
          <h1 className="font-display text-xl font-bold text-fg mt-3">{t('login.title')}</h1>
          <p className="mt-1 text-xs font-semibold tracking-wide text-primary-fg-strong">
            <span className="sr-only">{taglines[0]}</span>
            <span className="login-tagline-window" aria-hidden="true">
              <span className="login-tagline-track">
                {[...taglines, taglines[0]].map((tagline, index) => (
                  <span className="login-tagline-line" key={`${tagline}-${index}`}>
                    {tagline}
                  </span>
                ))}
              </span>
            </span>
          </p>
        </div>

        <Input
          type="email"
          data-testid="login-email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('login.emailPlaceholder')}
          autoFocus
          size="lg"
          className="mb-3"
        />

        <Input
          type="password"
          data-testid="login-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('login.password')}
          size="lg"
        />

        {error && <p className="text-danger text-sm mt-2 text-center">{error}</p>}

        <Button
          type="submit"
          size="lg"
          data-testid="login-submit"
          disabled={loading || !password.trim() || !email.trim()}
          className="mt-5 w-full rounded-xl"
        >
          {loading ? t('login.signingIn') : t('login.signIn')}
        </Button>

        {feishuAvailable && (
          <>
            <div className="mt-4 flex items-center gap-3" aria-hidden="true">
              <div className="h-px flex-1 bg-edge" />
              <span className="text-[10px] uppercase tracking-wide text-fg-faint">{t('login.or')}</span>
              <div className="h-px flex-1 bg-edge" />
            </div>
            <Button
              type="button"
              size="lg"
              variant="outline"
              disabled={feishuBusy}
              onClick={handleFeishuLogin}
              className="mt-4 w-full rounded-xl"
            >
              {feishuBusy ? t('login.feishuSigningIn') : t('login.feishu')}
            </Button>
          </>
        )}
      </form>
    </div>
  );
}
