/**
 * Options page — manage stations (self-hosted Greenhouse instances) and sign in.
 *
 * The stations card lists every saved station (click a row to switch the
 * active one), hosts the add-station flow (validate/normalize the URL, probe
 * /api/auth/status, request host permission for that origin) and, when the
 * active station is signed out, the email + password sign-in for it. Each
 * station keeps its own token pair, so switching never drops a session.
 */

import React, { useState } from 'react';
import { Button, Card, Input, Badge, Select, Spinner } from '@greenhouse/ui/components/ui';
import { LogOut, Trash2 } from '@greenhouse/ui/lib/icons';
import { useI18n, LOCALE_OPTIONS, type Locale } from '@greenhouse/ui/lib/i18n';
import { THEME_MODES, getThemeMode, setThemeMode, type ThemeMode } from '@greenhouse/ui/lib/theme';
import { normalizeBaseUrl, checkServer, requestHostPermission, login, logout, forgetStation } from '../lib/auth';
import { addStation, setActiveStation, type Station } from '../lib/storage';
import { useStations } from '../lib/use-auth';

export function OptionsApp() {
  const { t, setLocale, locale } = useI18n();
  const { state, loading } = useStations();

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const active = state.stations.find((s) => s.id === state.activeId) ?? null;

  return (
    <div className="mx-auto max-w-lg px-4 py-10 flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{t('options.title')}</h1>
        <p className="text-sm text-fg-muted mt-1">{t('options.subtitle')}</p>
      </div>

      <StationsCard stations={state.stations} active={active} />

      {active && !active.auth && <SignInCard station={active} onLoggedInLocale={(l) => setLocale(l)} />}

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

// ─── Stations card ───────────────────────────────────────

function StationsCard({ stations, active }: { stations: Station[]; active: Station | null }) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);

  return (
    <Card className="p-4 flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">{t('options.stations')}</h2>
        <p className="text-xs text-fg-muted mt-0.5">{t('options.stationsHint')}</p>
      </div>

      {stations.length === 0 && !adding && <p className="text-sm text-fg-muted">{t('options.noStations')}</p>}

      {stations.map((s) => (
        <StationRow key={s.id} station={s} isActive={s.id === active?.id} />
      ))}

      {adding ? (
        <AddStationForm onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
      ) : (
        <Button variant="outline" onClick={() => setAdding(true)}>
          {t('options.addStation')}
        </Button>
      )}
    </Card>
  );
}

function StationRow({ station, isActive }: { station: Station; isActive: boolean }) {
  const { t } = useI18n();

  const remove = async () => {
    if (!window.confirm(t('options.removeConfirm', { name: station.name }))) return;
    await forgetStation(station);
  };

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border p-2 ${
        isActive ? 'border-primary-500 bg-primary-50 dark:bg-primary-950' : 'border-edge'
      }`}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={() => setActiveStation(station.id)}
        title={station.baseUrl}
      >
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full border ${
            isActive ? 'border-primary-600 bg-primary-600' : 'border-edge-strong'
          }`}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium">
            <span className="truncate">{station.name}</span>
            {isActive && <Badge>{t('options.activeBadge')}</Badge>}
          </span>
          <span className="block truncate font-mono text-[11px] text-fg-muted">{station.baseUrl}</span>
          <span className="block truncate text-xs text-fg-secondary">
            {station.auth ? `${station.auth.user.nickname} · ${station.auth.user.role}` : t('options.signedOutBadge')}
          </span>
        </span>
      </button>
      {station.auth && (
        <button
          className="rounded p-1.5 text-fg-secondary hover:bg-surface-muted"
          title={t('options.signOut')}
          onClick={() => logout(station.id)}
        >
          <LogOut size={15} />
        </button>
      )}
      <button
        className="rounded p-1.5 text-fg-secondary hover:bg-surface-muted hover:text-danger-fg"
        title={t('options.removeStation')}
        onClick={remove}
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

// ─── Add-station flow ────────────────────────────────────

function AddStationForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [url, setUrl] = useState('');
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
      // Saved signed-out and made active; the sign-in card takes over. Adding
      // an origin that already exists just switches to it.
      await addStation(baseUrl);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-edge p-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-fg-secondary">{t('options.baseUrl')}</span>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('options.baseUrlPlaceholder')}
          disabled={busy}
          autoFocus
          onKeyDown={(e) => e.key === 'Enter' && connect()}
        />
      </label>
      <div className="flex gap-2">
        <Button onClick={connect} disabled={busy || !url.trim()}>
          {busy ? t('options.connecting') : t('options.connect')}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </Button>
      </div>
      {error && <p className="text-sm text-danger-fg">{error}</p>}
    </div>
  );
}

// ─── Sign-in card (active station without a session) ─────

function SignInCard({ station, onLoggedInLocale }: { station: Station; onLoggedInLocale: (locale: Locale) => void }) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await login(station, email.trim(), password);
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
      <div>
        <h2 className="text-sm font-semibold">{t('options.signIn')}</h2>
        <p className="mt-0.5 truncate font-mono text-xs text-fg-muted">{station.baseUrl}</p>
      </div>
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
      {error && <p className="text-sm text-danger-fg">{error}</p>}
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
