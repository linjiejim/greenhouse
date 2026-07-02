/**
 * Options page — connect to a Greenhouse instance and sign in.
 *
 * Two-step flow: validate/normalize the server URL (probe /api/auth/status +
 * request host permission for that origin), then email + password sign-in.
 * Once connected it shows the session and preferences (language, theme).
 */

import React, { useState } from 'react';
import { Button, Card, Input, Badge, Select, Spinner } from '@greenhouse/ui/components/ui';
import { useI18n, LOCALE_OPTIONS, type Locale } from '@greenhouse/ui/lib/i18n';
import { THEME_MODES, getThemeMode, setThemeMode, type ThemeMode } from '@greenhouse/ui/lib/theme';
import { normalizeBaseUrl, checkServer, requestHostPermission, login, logout } from '../lib/auth';
import { useAuth } from '../lib/use-auth';

type ConnectStep = { phase: 'url' } | { phase: 'credentials'; baseUrl: string };

export function OptionsApp() {
  const { t, setLocale, locale } = useI18n();
  const { auth, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-10 flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t('options.title')}</h1>
        <p className="text-sm text-fg-muted mt-1">{t('options.subtitle')}</p>
      </div>

      {auth ? <ConnectedCard /> : <ConnectCard onLoggedInLocale={(l) => setLocale(l)} />}

      <Card className="p-4 flex flex-col gap-3">
        <h2 className="text-sm font-semibold">{t('options.preferences')}</h2>
        <label className="flex items-center justify-between gap-4 text-sm">
          <span className="text-fg-secondary">{t('options.language')}</span>
          <Select size="sm" inline value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
            {LOCALE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.nativeLabel}
              </option>
            ))}
          </Select>
        </label>
        <ThemeRow />
      </Card>
    </div>
  );
}

// ─── Connect + sign-in flow ──────────────────────────────

function ConnectCard({ onLoggedInLocale }: { onLoggedInLocale: (locale: Locale) => void }) {
  const { t } = useI18n();
  const [step, setStep] = useState<ConnectStep>({ phase: 'url' });
  const [url, setUrl] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setError(null);
    const baseUrl = normalizeBaseUrl(url);
    if (!baseUrl) {
      setError(t('options.baseUrlInvalid'));
      return;
    }
    setBusy(true);
    try {
      // Host permission first — without it the probe itself is blocked by CORS.
      const granted = await requestHostPermission(baseUrl);
      if (!granted) {
        setError(t('options.permissionDenied'));
        return;
      }
      const probe = await checkServer(baseUrl);
      if (!probe.ok) {
        setError(t('options.serverUnreachable'));
        return;
      }
      if (probe.authEnabled === false) {
        setError(t('options.authDisabledHint'));
        return;
      }
      setUrl(baseUrl);
      setStep({ phase: 'credentials', baseUrl });
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    if (step.phase !== 'credentials') return;
    setError(null);
    setBusy(true);
    try {
      const result = await login(step.baseUrl, email.trim(), password);
      if (!result.ok) {
        setError(result.error === 'network' ? t('options.networkError') : t('options.loginFailed'));
        return;
      }
      const userLocale = result.auth.user.locale;
      if (userLocale === 'en' || userLocale === 'zh') onLoggedInLocale(userLocale);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4 flex flex-col gap-3">
      <h2 className="text-sm font-semibold">{t('options.connection')}</h2>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-fg-secondary">{t('options.baseUrl')}</span>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('options.baseUrlPlaceholder')}
          disabled={busy || step.phase === 'credentials'}
          onKeyDown={(e) => e.key === 'Enter' && step.phase === 'url' && connect()}
        />
      </label>

      {step.phase === 'url' && (
        <Button onClick={connect} disabled={busy || !url.trim()}>
          {busy ? t('options.connecting') : t('options.connect')}
        </Button>
      )}

      {step.phase === 'credentials' && (
        <>
          <h3 className="text-sm font-semibold mt-1">{t('options.signIn')}</h3>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-fg-secondary">{t('options.email')}</span>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} autoFocus />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-fg-secondary">{t('options.password')}</span>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              onKeyDown={(e) => e.key === 'Enter' && signIn()}
            />
          </label>
          <p className="text-xs text-fg-faint">{t('options.passwordHint')}</p>
          <Button onClick={signIn} disabled={busy || !email.trim() || !password}>
            {busy ? t('options.signingIn') : t('options.signInAction')}
          </Button>
        </>
      )}

      {error && <p className="text-sm text-danger-fg">{error}</p>}
    </Card>
  );
}

// ─── Connected state ─────────────────────────────────────

function ConnectedCard() {
  const { t } = useI18n();
  const { auth } = useAuth();
  if (!auth) return null;

  return (
    <Card className="p-4 flex flex-col gap-3">
      <h2 className="text-sm font-semibold">{t('options.connection')}</h2>
      <div className="flex flex-col gap-1 text-sm">
        <div className="flex items-center justify-between gap-4">
          <span className="text-fg-secondary">{t('options.connectedTo')}</span>
          <span className="font-mono text-xs">{auth.baseUrl}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-fg-secondary">{t('options.signedInAs')}</span>
          <span className="flex items-center gap-2">
            {auth.user.nickname}
            <Badge>{auth.user.role}</Badge>
          </span>
        </div>
      </div>
      <Button variant="outline" onClick={() => logout()}>
        {t('options.signOut')}
      </Button>
    </Card>
  );
}

// ─── Theme preference ────────────────────────────────────

function ThemeRow() {
  const { t } = useI18n();
  const [mode, setMode] = useState<ThemeMode>(() => getThemeMode());

  const labels: Record<ThemeMode, string> = {
    light: t('options.themeLight'),
    dark: t('options.themeDark'),
    system: t('options.themeSystem'),
  };

  return (
    <label className="flex items-center justify-between gap-4 text-sm">
      <span className="text-fg-secondary">{t('options.theme')}</span>
      <Select
        size="sm"
        inline
        value={mode}
        onChange={(e) => {
          const next = e.target.value as ThemeMode;
          setMode(next);
          setThemeMode(next);
        }}
      >
        {THEME_MODES.map((m) => (
          <option key={m} value={m}>
            {labels[m]}
          </option>
        ))}
      </Select>
    </label>
  );
}
