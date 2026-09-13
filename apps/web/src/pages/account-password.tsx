/** Branded pre-login account setup / password reset page. */

import React, { useEffect, useMemo, useState } from 'react';
import type { AuthenticatedUser } from '@greenhouse/types/api';

import { AppLogo, Button, Input, Spinner } from '../components/ui';
import { completePasswordLink, inspectPasswordLink, type PasswordLinkInspection } from '../lib/api/password-link';
import { useT } from '../lib/i18n';

function remainingLabel(expiresAt: string, now: number, expired: string, minutes: string, hours: string): string {
  const remainingMs = new Date(expiresAt).getTime() - now;
  if (remainingMs <= 0) return expired;
  const remainingMinutes = Math.ceil(remainingMs / 60_000);
  if (remainingMinutes < 60) return minutes.replace('{count}', String(remainingMinutes));
  return hours.replace('{count}', String(Math.ceil(remainingMinutes / 60)));
}

export function AccountPasswordPage({
  initialToken,
  onSuccess,
}: {
  initialToken: string | null;
  onSuccess: (user: AuthenticatedUser) => void;
}) {
  const t = useT();
  const [token] = useState(initialToken ?? '');
  const [inspection, setInspection] = useState<PasswordLinkInspection | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    // Fragment tokens never reached the server. Remove the last remaining copy
    // from browser chrome/history as soon as it is captured into component memory.
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/activate`);
    if (!token) {
      setError(t('accountPassword.invalid'));
      setLoading(false);
      return;
    }
    let cancelled = false;
    void inspectPasswordLink(token).then((result) => {
      if (cancelled) return;
      if (result.ok) setInspection(result.data);
      else setError(result.error || t('accountPassword.invalid'));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [t, token]);

  useEffect(() => {
    if (!inspection) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [inspection]);

  const remaining = useMemo(
    () =>
      inspection
        ? remainingLabel(
            inspection.expires_at,
            now,
            t('accountPassword.expired'),
            t('accountPassword.minutesRemaining'),
            t('accountPassword.hoursRemaining'),
          )
        : '',
    [inspection, now, t],
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password.length < 8) {
      setError(t('accountPassword.passwordMinLength'));
      return;
    }
    if (password !== confirmPassword) {
      setError(t('accountPassword.passwordMismatch'));
      return;
    }
    setSubmitting(true);
    setError('');
    const result = await completePasswordLink(token, password);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error || t('accountPassword.invalid'));
      return;
    }
    onSuccess(result.data.user);
    window.location.hash = '#/chat';
  };

  return (
    <div className="brand-auth-background app-viewport overflow-y-auto flex items-center justify-center px-4 py-[max(1rem,env(safe-area-inset-top))]">
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-edge bg-surface-raised p-6 shadow-xl shadow-primary-900/10 md:p-8 dark:shadow-black/30">
        <div className="brand-gradient absolute inset-x-0 top-0 h-1" aria-hidden="true" />
        <div className="text-center">
          <div className="mx-auto flex w-fit justify-center rounded-2xl bg-logo-safe p-2">
            <AppLogo size="xl" logoOnly />
          </div>
          <h1 className="font-display mt-3 text-xl font-bold text-fg">
            {inspection?.purpose === 'reset' ? t('accountPassword.resetTitle') : t('accountPassword.inviteTitle')}
          </h1>
          <p className="mt-2 text-sm leading-6 text-fg-muted">
            {inspection?.purpose === 'reset'
              ? t('accountPassword.resetDescription')
              : t('accountPassword.inviteDescription')}
          </p>
        </div>

        {loading ? (
          <div className="flex min-h-40 items-center justify-center">
            <Spinner />
          </div>
        ) : inspection ? (
          <form className="mt-6 space-y-4" onSubmit={submit}>
            <div className="rounded-xl border border-edge bg-surface-sunken px-4 py-3 text-sm">
              <div className="text-fg-secondary">{inspection.masked_email}</div>
              <div className="mt-1 text-xs text-fg-muted">{t('accountPassword.linkExpires', { remaining })}</div>
            </div>
            <Input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t('accountPassword.newPassword')}
              autoFocus
              size="lg"
            />
            <Input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder={t('accountPassword.confirmPassword')}
              size="lg"
            />
            {error && <p className="text-center text-sm text-danger">{error}</p>}
            <Button
              type="submit"
              size="lg"
              className="w-full rounded-xl"
              disabled={submitting || password.length < 8 || confirmPassword.length < 8}
            >
              {submitting ? t('accountPassword.settingPassword') : t('accountPassword.setPassword')}
            </Button>
          </form>
        ) : (
          <div className="mt-6 rounded-xl border border-danger/30 bg-danger-subtle px-4 py-4 text-center">
            <p className="text-sm font-medium text-danger">{t('accountPassword.unavailableTitle')}</p>
            <p className="mt-1 text-xs leading-5 text-fg-muted">{error || t('accountPassword.invalid')}</p>
            <Button variant="ghost" size="sm" className="mt-3" onClick={() => (window.location.hash = '#/chat')}>
              {t('accountPassword.backToLogin')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
