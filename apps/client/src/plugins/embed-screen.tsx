import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Platform, View } from 'react-native';
import { useFocusEffect, useNavigation, useRouter, useLocalSearchParams } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
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
import { useOpenHref, useStartChat } from '../shell/open-object';
import { embedMessage, embedTokens, embedUrl, normalizeNavigate } from './surface-model';
import { isBackAction, setEmbedBack } from './embed-back';
import { lucideIcon } from './icons';
import { confirmAction } from '../ui/dialogs';
import { notify } from '../ui/notify';
import { EMBED_PROTOCOL, type EmbedHeaderAction, type PluginEmbedPage } from '../shared/plugins';
export function EmbedScreen({ plugin, page, title }: { plugin: string; page: PluginEmbedPage; title: string }) {
  const { hex, isDark } = useTheme(),
    theme = isDark ? 'dark' : 'light',
    locale = usePrefs((s) => s.lang),
    user = useAuth((s) => s.user),
    router = useRouter(),
    params = useLocalSearchParams<{ route?: string }>(),
    t = useT(),
    start = useStartChat(),
    openHref = useOpenHref();
  const [frameTitle, setFrameTitle] = useState(title),
    [outgoing, setOutgoing] = useState<Record<string, unknown> | null>(null),
    [headerActions, setHeaderActions] = useState<EmbedHeaderAction[]>([]),
    [ownBack, setOwnBack] = useState(false),
    [error, setError] = useState('');
  const navigation = useNavigation();
  const tokens = useMemo(() => embedTokens(hex, isDark), [hex, isDark]);
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
      if (!r.ok) {
        setError(r.message || t('places.pluginError'));
        return;
      }
      credential.current = r.data;
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
  // Replies to the page's requests; a reply after the page has gone is dropped.
  const reply = (message: Record<string, unknown>) => {
    if (alive.current) setOutgoing(message);
  };
  // While the page shows a sub-view (`greenhouse:back`), every back control goes back inside it:
  // the header's back, Android back and the wide header's Back. Swipe-back is off meanwhile (native
  // stacks cannot cancel a swipe), and leaving for another place still closes the page.
  const requestBack = useCallback(() => {
    if (alive.current) setOutgoing({ type: EMBED_PROTOCOL.backRequest });
  }, []);
  usePreventRemove(ownBack, ({ data }) => {
    if (isBackAction(data.action.type)) requestBack();
    else navigation.dispatch(data.action);
  });
  const backKey = `${plugin}:${page.id}`;
  useEffect(() => {
    setEmbedBack(backKey, ownBack ? requestBack : null);
    return () => setEmbedBack(backKey, null);
  }, [backKey, ownBack, requestBack]);
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android' || !ownBack) return;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        requestBack();
        return true;
      });
      return () => sub.remove();
    }, [ownBack, requestBack]),
  );
  return (
    <>
      <Screen
        title={frameTitle}
        actions={headerActions.map((a) => ({
          icon: lucideIcon(a.icon) ?? 'apps',
          label: a.label,
          disabled: a.disabled,
          onPress: () => reply({ type: EMBED_PROTOCOL.headerAction, id: a.id }),
        }))}
      />
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
                if (m.type === EMBED_PROTOCOL.ready) {
                  // a page that (re)loads starts at its own top until it says otherwise
                  setOwnBack(false);
                  void sendInit();
                }
                if (m.type === EMBED_PROTOCOL.back) setOwnBack(m.enabled);
                if (m.type === EMBED_PROTOCOL.tokenRefresh) void sendInit(true);
                if (m.type === EMBED_PROTOCOL.title) setFrameTitle(m.title);
                if (m.type === EMBED_PROTOCOL.sendPrompt) {
                  start(m.text);
                }
                if (m.type === EMBED_PROTOCOL.header) setHeaderActions(m.actions);
                if (m.type === EMBED_PROTOCOL.route)
                  router.setParams({ route: m.route === '#/' ? undefined : m.route });
                if (m.type === EMBED_PROTOCOL.confirm) {
                  const id = m.id;
                  void confirmAction({
                    title: m.title,
                    message: m.body,
                    confirmLabel: m.confirmLabel,
                    cancelLabel: m.cancelLabel,
                    destructive: m.tone === 'danger',
                  }).then((ok) => reply({ type: EMBED_PROTOCOL.confirmResult, id, ok }));
                }
                if (m.type === EMBED_PROTOCOL.notify) {
                  const id = m.id;
                  const acted = () => reply({ type: EMBED_PROTOCOL.notifyAction, id });
                  // the page waits on a notice with an action until it is pressed or goes away
                  const onDismiss = () => reply({ type: EMBED_PROTOCOL.notifyDismissed, id });
                  const action = m.actionLabel ? { label: m.actionLabel, onPress: acted } : undefined;
                  if (m.kind === 'undo') notify.undo(m.text, acted, { onDismiss });
                  else notify[m.kind](m.text, { action, onDismiss: action ? onDismiss : undefined });
                }
                if (m.type === EMBED_PROTOCOL.navigate) {
                  // `#/…` and the client's own addresses (`/knowledge?doc=`) open the object here
                  const href = normalizeNavigate(m.href, getApiBase());
                  if (href) openHref(href);
                }
              },
            }}
          />
        )}
      </View>
    </>
  );
}
