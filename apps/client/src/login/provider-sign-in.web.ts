/**
 * Identity-provider sign-in on the browser's sign-in page (app/login.web.tsx). Which providers:
 * the station's public `/api/auth/providers` ∩ the plugin glue here (src/plugins/identity.ts),
 * so a button shows only while its plugin is enabled and configured. A click fetches a fresh
 * provider page (it mints a single-use state) and leaves for it; the provider returns to
 * `/login#…` with a one-shot code (held back before routing, src/login/entry-links.ts), which
 * becomes this station's session. The root gate then goes home.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { startProviderSignIn } from '../api/entry';
import { useT } from '../lib/i18n';
import { signInProviders, type IdentityGlue } from '../plugins/identity';
import { identityGlue } from '../plugins/identity-registry';
import { CLIENT_ROUTES } from '../shared/client-routes';
import { useAuth } from '../store/auth';
import { getApiBase } from '../store/stations';
import { discoverProviders } from './availability';
import { heldEntryParams, releaseEntryParams } from './entry-links';

export function useProviderSignIn() {
  const t = useT();
  const signInWith = useAuth((s) => s.signInWith);
  const loading = useAuth((s) => s.loading);
  const [providers, setProviders] = useState<IdentityGlue[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const returned = useRef(false);

  // A provider coming back: exchange its code, or say why it did not sign in.
  useEffect(() => {
    const params = heldEntryParams(CLIENT_ROUTES.login);
    releaseEntryParams(CLIENT_ROUTES.login);
    if (!params) return;
    for (const glue of identityGlue) {
      const back = glue.login?.read(params);
      if (!back || !glue.login) continue;
      returned.current = true;
      if (back.kind === 'error') {
        setError(t(glue.login.errorKey(back.reason)));
        return;
      }
      setBusy(glue.id);
      void signInWith(glue.login.exchangePath, { code: back.code }).then((result) => {
        setBusy(null);
        if (!result.ok) setError(result.error || t(glue.login!.errorKey('exchange')));
      });
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the return is read once, on arrival
  }, []);

  const start = useCallback(
    async (glue: IdentityGlue) => {
      if (!glue.login) return;
      setBusy(glue.id);
      setError(null);
      const result = await startProviderSignIn(glue.login.startPath);
      if (result.ok && typeof result.data.authorize_url === 'string') {
        window.location.assign(result.data.authorize_url);
        return;
      }
      setBusy(null);
      setError((!result.ok && result.message) || t(glue.login.errorKey('start')));
    },
    [t],
  );

  useEffect(() => {
    if (loading) return;
    let alive = true;
    void discoverProviders((path) => fetch(`${getApiBase()}${path}`))
      .catch(() => [])
      .then((discovered) => {
        if (!alive) return;
        const offered = signInProviders(identityGlue, discovered);
        setProviders(offered);
        // inside a provider's own app, go straight to it (once per tab; never after a return)
        const auto = returned.current ? undefined : offered.find((glue) => glue.login?.autoStart?.());
        if (auto) void start(auto);
      });
    return () => {
      alive = false;
    };
  }, [loading, start]);

  return { providers, busy, error, clearError: () => setError(null), start };
}
