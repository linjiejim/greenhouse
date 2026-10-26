/**
 * 登录界面 — 内部用户邮箱密码登录 + 飞书扫码登录（部署配置了飞书应用才显示）。
 */

import React, { useState } from 'react';
import { Button, Input } from '../ui';
import { BrandIntro } from './brand-intro';
import { loginInternal } from '../../lib/auth';
import type { AuthenticatedUser } from '../../lib/auth';
import { PublicProviderLogin } from './provider-login';
import { useT } from '../../lib/i18n';

export function LoginScreen({ onSuccess }: { onSuccess: (user: AuthenticatedUser) => void }) {
  const t = useT();
  const taglines = [t('login.taglineSmarterWork'), t('login.taglineSharedKnowledge'), t('login.taglineTeamMomentum')];
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
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
    >
      <form
        onSubmit={handleSubmit}
        className="relative w-full max-w-sm overflow-hidden rounded-xl border border-edge bg-surface-raised p-6 shadow-xl shadow-primary-900/10 md:p-8 dark:shadow-black/30"
      >
        <div className="text-center mb-6">
          <div className="mx-auto flex w-fit justify-center rounded-xl bg-logo-safe p-2">
            <BrandIntro className="h-16 w-16" />
          </div>
          <h1 className="text-xl font-bold text-fg mt-3">{t('login.title')}</h1>
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
          className="mt-5 w-full rounded-lg"
        >
          {loading ? t('login.signingIn') : t('login.signIn')}
        </Button>

        <PublicProviderLogin onSuccess={onSuccess} onError={setError} />
      </form>
    </div>
  );
}
