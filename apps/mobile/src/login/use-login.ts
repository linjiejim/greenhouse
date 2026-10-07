/**
 * The sign-in flow behind both platforms' login screens (app/login.tsx — SwiftUI,
 * app/login.android.tsx — Material): the active station, the inline error
 * (shown under the fields, cleared as soon as the user edits), and `submit`,
 * which reads the native fields (they own their text — AutoFill writes into
 * them directly) and routes home on success.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
import { useAuth } from '../store/auth';
import { useActiveStation } from '../stations/use-active-station';
import { useT } from '../lib/i18n';

export function useLogin(fields: { email: () => string | undefined; password: () => string | undefined }) {
  const t = useT();
  const doLogin = useAuth((s) => s.login);
  const router = useRouter();
  const station = useActiveStation();
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
    if (res.ok) router.replace('/');
    else setError(res.error || t('login.failed'));
  }, [busy, station, readEmail, readPassword, doLogin, router, t, openStations]);

  return { station, error, busy, submit, clearError, openStations };
}
