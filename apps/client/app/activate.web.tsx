/**
 * `/activate#token=` — one-time account setup (an invitation) or a required password reset, from
 * the mail an administrator sent (apps/api/src/security/account.ts). Reachable signed out.
 *
 * The token arrives in the fragment and was held back from the address before routing
 * (src/login/entry-links.ts); it lives only in this page's memory and goes only into the two
 * public calls' bodies. Inspecting never consumes the link; setting the password does, and signs
 * the new member in (then the root gate goes home).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { inspectPasswordLink, PASSWORD_LINK_COMPLETE, type PasswordLink } from '../src/api/entry';
import { useT } from '../src/lib/i18n';
import { EntryFrame, EntryHead, EntryState } from '../src/login/entry-frame.web';
import { heldEntryParams, markActivated, releaseEntryParams, takeActivated } from '../src/login/entry-links';
import { CLIENT_ROUTES } from '../src/shared/client-routes';
import { useAuth } from '../src/store/auth';

const MIN_PASSWORD = 8;

export default function Activate() {
  const t = useT();
  const router = useRouter();
  const signInWith = useAuth((s) => s.signInWith);
  const [token] = useState(() => heldEntryParams(CLIENT_ROUTES.activate)?.get('token') ?? '');
  useEffect(() => releaseEntryParams(CLIENT_ROUTES.activate), []);

  const [attempt, setAttempt] = useState(0);
  const [link, setLink] = useState<PasswordLink | null>(null);
  const [problem, setProblem] = useState<{ message: string; retry: boolean } | null>(
    token ? null : { message: '', retry: false },
  );
  useEffect(() => {
    if (!token) return;
    let alive = true;
    setProblem(null);
    void inspectPasswordLink(token).then((result) => {
      if (!alive) return;
      if (result.ok) setLink(result.data);
      // an unreachable station or a busy one may answer next time; a bad link never will
      else setProblem({ message: result.message, retry: result.status === 0 || result.status >= 429 });
    });
    return () => {
      alive = false;
    };
  }, [token, attempt]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!link) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [link]);
  const expiry = useMemo(() => {
    if (!link) return '';
    const minutes = Math.ceil((new Date(link.expires_at).getTime() - now) / 60_000);
    if (minutes <= 0) return t('entry.activate.expired');
    return minutes < 60
      ? t('entry.activate.expiresMinutes', { count: minutes })
      : t('entry.activate.expiresHours', { count: Math.ceil(minutes / 60) });
  }, [link, now, t]);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    if (password.length < MIN_PASSWORD) return setError(t('entry.activate.minLength'));
    if (password !== confirm) return setError(t('entry.activate.mismatch'));
    setBusy(true);
    setError(null);
    markActivated();
    const result = await signInWith(PASSWORD_LINK_COMPLETE, { token, password });
    if (!result.ok) {
      takeActivated();
      setBusy(false);
      setError(result.error || t('entry.activate.invalid'));
    }
  };

  const reset = link?.purpose === 'reset';
  const title = reset ? t('entry.activate.resetTitle') : t('entry.activate.inviteTitle');
  return (
    <EntryFrame label={title} testID="activate-page">
      <EntryHead
        title={title}
        detail={reset ? t('entry.activate.resetDescription') : t('entry.activate.inviteDescription')}
      />
      {problem ? (
        <EntryState
          tone="danger"
          title={t('entry.activate.unavailableTitle')}
          detail={problem.message || t('entry.activate.invalid')}
          testID="activate-unavailable"
        >
          <button
            type="button"
            className="gh-secondary-button"
            onClick={() => (problem.retry ? setAttempt((n) => n + 1) : router.replace('/login'))}
          >
            {problem.retry ? t('common.retry') : t('entry.activate.toLogin')}
          </button>
        </EntryState>
      ) : !link ? (
        <EntryState tone="working" title={t('entry.activate.checking')} />
      ) : (
        <form
          className="gh-entry-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="gh-callout" data-tone="neutral" data-testid="activate-account">
            <div className="gh-callout-text">
              {link.masked_email}
              <small>{expiry}</small>
            </div>
          </div>
          <input
            className="gh-input"
            data-testid="activate-password"
            type="password"
            autoComplete="new-password"
            aria-label={t('entry.activate.newPassword')}
            placeholder={t('entry.activate.newPassword')}
            value={password}
            autoFocus
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
          />
          <input
            className="gh-input"
            data-testid="activate-confirm"
            type="password"
            autoComplete="new-password"
            aria-label={t('entry.activate.confirmPassword')}
            placeholder={t('entry.activate.confirmPassword')}
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              setError(null);
            }}
          />
          {error ? (
            <p className="gh-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            className="gh-primary"
            data-testid="activate-submit"
            disabled={busy || password.length < MIN_PASSWORD || confirm.length < MIN_PASSWORD}
          >
            {busy ? t('entry.activate.submitting') : t('entry.activate.submit')}
          </button>
        </form>
      )}
    </EntryFrame>
  );
}
