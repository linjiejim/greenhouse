import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { post } from '../api/client';
import { captureIdentity } from '../data/identity';
import { getApiBase } from '../store/stations';
import { useAuth } from '../store/auth';
import { usePrefs } from '../store/prefs';
import { useTheme } from '../theme';
import { useT } from '../lib/i18n';
import { Screen } from '../ui/screen';
import { WebFrame } from '../ui/web-frame';
import { EmptyState } from '../ui/empty';
import { useStartChat } from '../shell/open-object';
import { mapLegacyLink } from '../shell/legacy-links';
import { embedMessage, embedUrl, normalizeNavigate } from './surface-model';
import { EMBED_PROTOCOL, type PluginEmbedPage } from '../shared/plugins';
export function EmbedScreen({ plugin, page, title }: { plugin: string; page: PluginEmbedPage; title: string }) {
  const { hex, isDark } = useTheme(),
    theme = isDark ? 'dark' : 'light',
    locale = usePrefs((s) => s.lang),
    user = useAuth((s) => s.user),
    router = useRouter(),
    params = useLocalSearchParams<{ route?: string }>(),
    t = useT(),
    start = useStartChat();
  const [frameTitle, setFrameTitle] = useState(title),
    [outgoing, setOutgoing] = useState<Record<string, unknown> | null>(null),
    [error, setError] = useState('');
  const tokens = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(hex).map(([key, value]) => [
          `--gh-${key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`,
          value,
        ]),
      ),
    [hex],
  );
  // Keep iframe URL stable across theme changes; bridge updates preserve plugin state.
  const [initial] = useState({ theme, locale });
  const url = embedUrl(page.url, getApiBase(), initial.theme, initial.locale);
  const origin = url ? new URL(url).origin : '';
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const credential = useRef<{ token: string; expires_at: string }>({ token: '', expires_at: '' });
  const gen = useRef(0);
  const sendInit = useCallback(
    async (refresh = false) => {
      const current = captureIdentity(),
        attempt = ++gen.current;
      const r = await post<{ token: string; expires_at: string }>('/api/ext-ui/token', { plugin });
      if (!alive.current || !current() || attempt !== gen.current) return;
      if (!r.ok && r.status !== 404) {
        setError(r.message || t('places.pluginError'));
        return;
      }
      credential.current = r.ok ? r.data : { token: '', expires_at: '' };
      setError('');
      setOutgoing(
        refresh
          ? { type: EMBED_PROTOCOL.token, ...credential.current }
          : {
              type: EMBED_PROTOCOL.init,
              theme,
              tokens,
              locale,
              user: user ? { id: user.id, name: user.nickname, role: user.role } : null,
              route: params.route ?? '',
              ...credential.current,
            },
      );
    },
    [plugin, theme, tokens, locale, user, params.route, t],
  );
  const latestInit = useRef(sendInit);
  latestInit.current = sendInit;
  useEffect(() => {
    setOutgoing({ type: EMBED_PROTOCOL.theme, theme, tokens });
  }, [theme, tokens]);
  const loaded = useCallback(() => void latestInit.current(), []);
  return (
    <>
      <Screen title={frameTitle} />
      <View style={{ flex: 1 }}>
        {!url || error ? (
          <EmptyState
            icon="alert"
            title={error || t('client.pluginUnavailable')}
            onRetry={url ? () => void sendInit() : undefined}
          />
        ) : (
          <WebFrame
            source={{ uri: url }}
            style={{ flex: 1 }}
            bridge={{
              origin,
              outgoing,
              title: frameTitle,
              onLoad: loaded,
              onMessage: (raw, eventOrigin) => {
                const m = embedMessage(raw, eventOrigin, origin, getApiBase());
                if (!m) return;
                if (m.type === EMBED_PROTOCOL.ready) void sendInit();
                if (m.type === EMBED_PROTOCOL.tokenRefresh) void sendInit(true);
                if (m.type === EMBED_PROTOCOL.title) setFrameTitle(m.title);
                if (m.type === EMBED_PROTOCOL.sendPrompt) {
                  start(m.text);
                }
                if (m.type === EMBED_PROTOCOL.navigate) {
                  const normalized = normalizeNavigate(m.href, getApiBase());
                  const href = normalized?.startsWith('#/') ? mapLegacyLink(normalized) : normalized;
                  if (href && !href.startsWith('/classic/')) router.navigate(href as never);
                }
              },
            }}
          />
        )}
      </View>
    </>
  );
}
