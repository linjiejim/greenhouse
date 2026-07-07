/**
 * 登录界面 — 支持内部用户邮箱密码登录、外部访客密码登录，以及已配置的
 * SSO 身份提供方（企业微信 / 飞书 / fork 连接器）一键登录。
 */

import React, { useEffect, useState } from 'react';
import { Input, AppLogo } from '../ui';
import { loginInternal, loginExternal, fetchSsoProviders, ssoAuthorizeUrl } from '../../lib/auth';
import type { AuthenticatedUser, SsoProviderInfo } from '../../lib/auth';
import { useT } from '../../lib/i18n';
import { BRANDING } from '../../lib/branding.extensions';

/** Known callback error codes → i18n keys; anything else shows the generic message. */
const SSO_ERROR_KEYS: Record<string, string> = {
  not_bound: 'login.ssoNotBound',
  email_conflict: 'login.ssoEmailConflict',
  account_disabled: 'login.ssoAccountDisabled',
  provider_error: 'login.ssoProviderError',
  invalid_state: 'login.ssoInvalidState',
};

export function LoginScreen({
  onSuccess,
  ssoError,
}: {
  onSuccess: (user: AuthenticatedUser) => void;
  /** Error surfaced by the SSO callback landing (code or message). */
  ssoError?: string | null;
}) {
  const t = useT();
  const [mode, setMode] = useState<'internal' | 'external'>('internal');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ssoProviders, setSsoProviders] = useState<SsoProviderInfo[]>([]);

  useEffect(() => {
    fetchSsoProviders().then(setSsoProviders);
  }, []);

  useEffect(() => {
    if (ssoError) {
      const key = SSO_ERROR_KEYS[ssoError];
      setError(key ? t(key) : t('login.ssoFailed'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- error text derives from the one-shot code
  }, [ssoError]);

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
          <h1 className="text-xl font-semibold text-fg mt-2">{BRANDING.productName}</h1>
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

        {/* SSO providers — only rendered when the server has connectors configured */}
        {ssoProviders.length > 0 && (
          <div className="mt-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="flex-1 h-px bg-edge" />
              <span className="text-[11px] text-fg-faint">{t('login.ssoDivider')}</span>
              <div className="flex-1 h-px bg-edge" />
            </div>
            <div className="space-y-2">
              {ssoProviders.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`login-sso-${p.id}`}
                  onClick={() => {
                    window.location.href = ssoAuthorizeUrl(p.id, `/${window.location.hash}`);
                  }}
                  className="w-full py-2.5 rounded-xl border border-edge text-sm font-medium text-fg-secondary hover:border-edge-strong hover:bg-surface-sunken transition-colors"
                >
                  {t('login.ssoContinueWith', { provider: p.label })}
                </button>
              ))}
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
