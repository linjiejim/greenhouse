/**
 * The sign-in flow behind both platforms' login screens (app/login.tsx — SwiftUI,
 * app/login.android.tsx — Material): the active station, the inline error
 * (shown under the fields, cleared as soon as the user edits), and `submit`,
 * which reads the native fields (they own their text — AutoFill writes into
 * them directly). The root auth gate alone routes home on success.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
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

  const connectionError = startupError ? t(startupError === 'timeout' ? 'station.timeout' : 'station.connectionFailed') : null;
  return { station, productName, error, connectionError, retry, busy, submit, clearError, openStations };
}
