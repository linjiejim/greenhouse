/**
 * The sign-in flow behind both platforms' login screens (app/login.tsx — SwiftUI,
 * app/login.android.tsx — Material): the active station, the inline error
 * (shown under the fields, cleared as soon as the user edits), and `submit`,
 * which reads the native fields (they own their text — AutoFill writes into
 * them directly). The root auth gate alone routes home on success.
 *
 * Feishu sign-in (./feishu.ts) is offered when the station says it is configured: the system auth
 * session opens Feishu, comes back to the app's own address with a one-shot code, and the code
 * becomes this station's session.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { getApiBase } from '../store/stations';
import { FEISHU_APP_REDIRECT, feishuErrorKey, parseFeishuReturn } from './feishu';
import { feishuLoginAvailable } from './availability';
import { useAuth } from '../store/auth';
import { useActiveStation } from '../stations/use-active-station';
import { useT } from '../lib/i18n';

export function useLogin(fields: { email: () => string | undefined; password: () => string | undefined }) {
  const t = useT();
  const doLogin = useAuth((s) => s.login);
  const startupError = useAuth((s) => s.startupError);
  const retry = useAuth((s) => s.bootstrap);
  const router = useRouter();
  const station = useActiveStation();
  // the station's own name before sign-in (`/api/bootstrap`), else the product's
  const productName = useAuth((s) => s.station?.product_name) || 'Greenhouse';
  const [error, setError] = useState<string | null>(null);
  const loginWithFeishu = useAuth((s) => s.loginWithFeishu);
  const [feishu, setFeishu] = useState(false);
  const stationKey = station?.id ?? '';
  const mobileApi = useAuth((s) => s.station?.mobile_api);
  const loading = useAuth((s) => s.loading);
  useEffect(() => {
    setFeishu(false);
    if (!stationKey || loading || mobileApi === undefined) return;
    let alive = true;
    void feishuLoginAvailable(mobileApi, (path) => fetch(`${getApiBase()}${path}`))
      .then((available) => {
        if (alive) setFeishu(available);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [stationKey, mobileApi, loading]);
  const [busy, setBusy] = useState(false);
  const { email: readEmail, password: readPassword } = fields;

  const openStations = useCallback(() => router.push('/sheets/stations'), [router]);
  // a stale error goes away as soon as the user starts fixing the input
  const clearError = useCallback(() => setError(null), []);

  const submit = useCallback(async () => {
    if (busy) return;
    if (!station) {
      setError(t('login.noStation'));
      openStations();
      return;
    }
    const email = (readEmail() ?? '').trim();
    const password = readPassword() ?? '';
    if (!email || !password) {
      setError(t('login.missingFields'));
      return;
    }
    setBusy(true);
    setError(null);
    const res = await doLogin(email, password);
    setBusy(false);
    // Updating auth already triggers the root layout's redirect. A second
    // replace here can update a native-stack header after its screen detached.
    if (!res.ok) setError(res.error || t('login.failed'));
  }, [busy, station, readEmail, readPassword, doLogin, t, openStations]);

  const signInWithFeishu = useCallback(async () => {
    if (busy || !station) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `${getApiBase()}/api/feishu/oauth/start-login?app_redirect=${encodeURIComponent(FEISHU_APP_REDIRECT)}`,
      );
      const body = res.ok ? ((await res.json()) as { authorize_url?: unknown }) : null;
      if (typeof body?.authorize_url !== 'string') {
        setError(t('login.feishuFailed'));
        return;
      }
      const session = await WebBrowser.openAuthSessionAsync(body.authorize_url, FEISHU_APP_REDIRECT, {
        preferEphemeralSession: true,
      });
      const back = parseFeishuReturn(session.type === 'success' ? session.url : null);
      if (back.kind === 'cancel') return;
      if (back.kind === 'error') {
        setError(t(feishuErrorKey(back.reason)));
        return;
      }
      const result = await loginWithFeishu(back.code);
      if (!result.ok) setError(result.error || t('login.feishuFailed'));
    } catch {
      setError(t('login.networkError'));
    } finally {
      setBusy(false);
    }
  }, [busy, station, t, loginWithFeishu]);

  const connectionError = startupError ? t(startupError === 'timeout' ? 'station.timeout' : 'station.connectionFailed') : null;
  return {
    station,
    productName,
    error,
    connectionError,
    retry,
    busy,
    submit,
    clearError,
    openStations,
    feishu,
    signInWithFeishu,
  };
}
