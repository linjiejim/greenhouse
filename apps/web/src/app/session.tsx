/**
 * The signed-in member and everything tied to the session: the realtime socket, the theme
 * and the language. Signing out anywhere (this tab, another tab, a refused refresh) clears
 * the cache and shows sign-in.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_VERSION, type Bootstrap, type Me } from '@greenhouse/contract';
import type { RealtimeStatus } from '@greenhouse/contract/client';
import { api, onSignedOut } from '../lib/api';
import { asLocale, browserLocale, I18nProvider, type Locale } from '../lib/i18n';
import { browserTokens, onOtherTab } from '../lib/tokens';
import { keys } from '../data/query';
import { afterReconnect, applyEvent } from '../data/realtime';
import { clearStreams } from '../data/streams';

interface Session {
  bootstrap: Bootstrap | undefined;
  /** Undefined until loaded, or while signed out. */
  me: Me | undefined;
  /** Loading the member failed for a reason other than the session ending. */
  meError: boolean;
  retryMe(): void;
  signedIn: boolean;
  realtime: RealtimeStatus;
  /** The server speaks a newer API than this page. */
  outdated: boolean;
  signIn(email: string, password: string): Promise<void>;
  /** After an activation or reset link set the password. */
  signedInWithLink(): void;
  signOut(): Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionProvider');
  return session;
}

/** For pages that only render signed in. */
export function useMe(): Me {
  const { me } = useSession();
  if (!me) throw new Error('useMe before the member is loaded');
  return me;
}

function applyTheme(theme: Me['theme'] | undefined) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [signedIn, setSignedIn] = useState(() => browserTokens.get() !== null);
  const [realtime, setRealtime] = useState<RealtimeStatus>('closed');

  const reset = useCallback(() => {
    client.clear();
    clearStreams();
  }, [client]);

  useEffect(
    () =>
      onSignedOut(() => {
        setSignedIn(false);
        reset();
      }),
    [reset],
  );
  useEffect(
    () =>
      onOtherTab((value) => {
        setSignedIn(value);
        if (value) void client.invalidateQueries();
        else reset();
      }),
    [client, reset],
  );

  const bootstrap = useQuery({ queryKey: keys.bootstrap, queryFn: api.bootstrap, staleTime: 5 * 60_000 });
  const me = useQuery({ queryKey: keys.me, queryFn: api.me.get, enabled: signedIn });

  useEffect(() => applyTheme(me.data?.theme), [me.data?.theme]);

  const ready = signedIn && me.isSuccess;
  useEffect(() => {
    if (!ready) return;
    const connection = api.connect({
      onEvent: (event) => applyEvent(client, event),
      onReady: ({ reconnected }) => {
        if (reconnected) afterReconnect(client);
      },
      onStatus: setRealtime,
    });
    const retry = () => {
      if (document.visibilityState === 'visible') connection.retry();
    };
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', retry);
    return () => {
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', retry);
      connection.close();
      setRealtime('closed');
    };
  }, [ready, client]);

  const { data: member, isError: memberFailed, refetch: refetchMe } = me;
  const value = useMemo<Session>(
    () => ({
      bootstrap: bootstrap.data,
      me: signedIn ? member : undefined,
      meError: signedIn && memberFailed && !member,
      retryMe: () => void refetchMe(),
      signedIn,
      realtime,
      outdated: bootstrap.data !== undefined && bootstrap.data.api_version > API_VERSION,
      async signIn(email, password) {
        await api.auth.login(email, password);
        reset();
        setSignedIn(true);
      },
      signedInWithLink() {
        reset();
        setSignedIn(true);
      },
      async signOut() {
        await api.auth.logout();
        reset();
        setSignedIn(false);
      },
    }),
    [bootstrap.data, member, memberFailed, refetchMe, signedIn, realtime, reset],
  );

  const locale: Locale = me.data ? asLocale(me.data.locale) : browserLocale();
  return (
    <SessionContext.Provider value={value}>
      <I18nProvider locale={locale}>{children}</I18nProvider>
    </SessionContext.Provider>
  );
}
