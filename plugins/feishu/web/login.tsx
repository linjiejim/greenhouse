import React, { useState, useEffect } from 'react';
import { Button, useT, type AuthenticatedUser } from '@greenhouse/web/extension-kit';
import {
  exchangeFeishuLoginCode,
  feishuAutoLoginAttempted,
  isInsideFeishuClient,
  markFeishuAutoLoginAttempted,
  startFeishuLogin,
} from './api';
export function FeishuLogin({
  onSuccess,
  onError: setError,
}: {
  onSuccess: (user: AuthenticatedUser) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  // Feishu login: hidden unless the deployment has the app configured. The
  // mount-time probe doubles as the availability check — a button that always
  // 503s is a capability claim the product cannot honour.
  const feishuAvailable = true;
  const [feishuBusy, setFeishuBusy] = useState(false);

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
          else setError(result.error || t('ext.feishu.login.feishuFailed'));
        })
        .finally(() => setFeishuBusy(false));
      return;
    }
    const reason = params.get('reason');
    // A failed auto-login must not re-trigger itself — see the auto-login effect.
    markFeishuAutoLoginAttempted();
    setError(reason === 'not_bound' ? t('ext.feishu.login.feishuNotBound') : t('ext.feishu.login.feishuFailed'));
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
    setError(result.error || t('ext.feishu.login.feishuFailed'));
    setFeishuBusy(false);
  };

  return (
    <>
      <div className="mt-4 flex items-center gap-3" aria-hidden="true">
        <div className="h-px flex-1 bg-edge" />
        <span className="text-caption uppercase tracking-wide text-fg-faint">{t('ext.feishu.login.or')}</span>
        <div className="h-px flex-1 bg-edge" />
      </div>
      <Button
        type="button"
        size="lg"
        variant="outline"
        disabled={feishuBusy}
        onClick={handleFeishuLogin}
        className="mt-4 w-full rounded-lg"
      >
        {feishuBusy ? t('ext.feishu.login.feishuSigningIn') : t('ext.feishu.login.feishu')}
      </Button>
    </>
  );
}
