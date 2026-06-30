/**
 * 登录界面 — 支持内部用户邮箱密码登录和外部访客密码登录。
 */

import React, { useState } from 'react';
import { Input, AppLogo } from '../ui';
import { loginInternal, loginExternal } from '../../lib/auth';
import type { AuthenticatedUser } from '../../lib/auth';
import { useT } from '../../lib/i18n';

export function LoginScreen({ onSuccess }: { onSuccess: (user: AuthenticatedUser) => void }) {
  const t = useT();
  const [mode, setMode] = useState<'internal' | 'external'>('internal');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setLoading(true);
    setError('');

    if (mode === 'internal') {
      if (!email.trim()) {
        setError(t('login.emailRequired'));
        setLoading(false);
        return;
      }
      const result = await loginInternal(email.trim(), password.trim());
      setLoading(false);
      if (result.ok && result.user) {
        onSuccess(result.user);
      } else {
        setError(result.error || t('login.loginFailed'));
        setPassword('');
      }
    } else {
      const result = await loginExternal(password.trim());
      setLoading(false);
      if (result.ok && result.user) {
        onSuccess(result.user);
      } else {
        setError(result.error || t('login.invalidPassword'));
        setPassword('');
      }
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-surface-sunken">
      <form
        onSubmit={handleSubmit}
        className="bg-surface-raised rounded-2xl shadow-lg p-6 md:p-8 w-full max-w-sm mx-4 md:mx-0"
      >
        <div className="text-center mb-6">
          <div className="flex justify-center">
            <AppLogo size="xl" logoOnly />
          </div>
          <h1 className="text-xl font-semibold text-fg mt-2">{t('login.title')}</h1>
          <p className="text-sm text-fg-muted mt-1">{t('login.subtitle')}</p>
        </div>

        {/* Mode toggle */}
        <div className="flex bg-surface-muted rounded-lg p-0.5 mb-4">
          <button
            type="button"
            data-testid="login-tab-team"
            onClick={() => {
              setMode('internal');
              setError('');
            }}
            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
              mode === 'internal' ? 'bg-surface-raised text-primary-fg-strong font-medium shadow-sm' : 'text-fg-muted'
            }`}
          >
            {t('login.teamLogin')}
          </button>
          <button
            type="button"
            data-testid="login-tab-guest"
            onClick={() => {
              setMode('external');
              setError('');
            }}
            className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
              mode === 'external' ? 'bg-surface-raised text-primary-fg-strong font-medium shadow-sm' : 'text-fg-muted'
            }`}
          >
            {t('login.guestAccess')}
          </button>
        </div>

        {mode === 'internal' && (
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
        )}

        <Input
          type="password"
          data-testid="login-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={mode === 'internal' ? t('login.password') : t('login.accessCode')}
          autoFocus={mode === 'external'}
          size="lg"
        />

        {error && <p className="text-danger text-sm mt-2 text-center">{error}</p>}

        <button
          type="submit"
          data-testid="login-submit"
          disabled={loading || !password.trim() || (mode === 'internal' && !email.trim())}
          className="w-full mt-4 py-3 bg-primary-600 text-white rounded-xl text-sm font-medium hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? t('login.signingIn') : mode === 'internal' ? t('login.signIn') : t('login.enter')}
        </button>
      </form>
    </div>
  );
}
