import React, { useCallback, useEffect, useRef, useState } from 'react';
import { EMBED_PROTOCOL, localize, type PluginEmbedPage } from '@greenhouse/types/plugins';
import { tokenNames, resolveThemeTokens } from '@greenhouse/ui-tokens';
import { authFetch } from '../lib/auth';
import { useAuthStore } from '../stores/auth-store';
import { useI18n } from '../lib/i18n';
import { useAgentContext } from '../components/agent-context';

export function embedTheme() {
  const root = document.documentElement;
  const theme = root.classList.contains('dark-theme') ? 'dark' : 'light';
  const computed = getComputedStyle(root);
  return {
    theme,
    tokens: resolveThemeTokens(
      theme,
      Object.fromEntries(
        tokenNames.map((name) => [name, computed.getPropertyValue(name).trim()]).filter(([, value]) => value),
      ),
    ),
  };
}

export function embedNavigation(href: unknown, origin: string): string | null {
  if (typeof href !== 'string' || href.length > 4096) return null;
  try {
    const url = new URL(href, origin);
    return url.origin === origin && !url.username && !url.password && url.hash.startsWith('#/') ? url.hash : null;
  } catch {
    return null;
  }
}

export function EmbedPage({ plugin, page, route }: { plugin: string; page: PluginEmbedPage; route: string }) {
  const { locale, t } = useI18n(),
    user = useAuthStore((s) => s.currentUser);
  const { launchAssistant } = useAgentContext();
  const frame = useRef<HTMLIFrameElement>(null),
    attempt = useRef(0),
    mounted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [title, setTitle] = useState(localize(page.title, locale)),
    [error, setError] = useState('');
  // Initial query params are hints; subsequent theme changes go through the bridge.
  const [src] = useState(() => {
    const url = new URL(page.url, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith(`/ext/${plugin}/ui/`)) return '';
    url.searchParams.set('theme', embedTheme().theme);
    url.searchParams.set('locale', locale);
    return url.href;
  });
  const post = useCallback(
    (message: object) => frame.current?.contentWindow?.postMessage(message, window.location.origin),
    [],
  );
  const send = useCallback(
    async (refresh = false) => {
      const id = ++attempt.current,
        member = user?.id;
      try {
        const response = await authFetch('/api/ext-ui/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plugin }),
        });
        const credential = await response.json();
        if (!mounted.current || id !== attempt.current || useAuthStore.getState().currentUser?.id !== member) return;
        if (!response.ok) throw new Error(credential.error ?? t('app.extensionUnavailable'));
        setError('');
        post(
          refresh
            ? { type: EMBED_PROTOCOL.token, ...credential }
            : {
                type: EMBED_PROTOCOL.init,
                ...embedTheme(),
                locale,
                user: { id: member, name: user?.nickname ?? '', role: user?.role },
                route,
                ...credential,
              },
        );
        clearTimeout(timer.current);
        timer.current = setTimeout(
          () => void latest.current(true),
          Math.max(1000, Date.parse(credential.expires_at) - Date.now() - 60_000),
        );
      } catch (e) {
        if (mounted.current && id === attempt.current)
          setError(e instanceof Error ? e.message : t('app.extensionUnavailable'));
      }
    },
    [plugin, user, locale, route, post, t],
  );
  const latest = useRef(send);
  latest.current = send;
  useEffect(() => {
    mounted.current = true;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin) return;
      const m = event.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === EMBED_PROTOCOL.ready) void latest.current();
      if (m.type === EMBED_PROTOCOL.tokenRefresh) void latest.current(true);
      if (m.type === EMBED_PROTOCOL.navigate) {
        const hash = embedNavigation(m.href, window.location.origin);
        if (hash) window.location.hash = hash;
      }
      if (m.type === EMBED_PROTOCOL.title && typeof m.title === 'string') setTitle(m.title.slice(0, 200));
      if (m.type === EMBED_PROTOCOL.sendPrompt && typeof m.text === 'string' && m.text.length <= 32_000)
        launchAssistant({ draft: m.text, autoSend: false });
    };
    window.addEventListener('message', receive);
    const observer = new MutationObserver(() => post({ type: EMBED_PROTOCOL.theme, ...embedTheme() }));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      observer.disconnect();
      window.removeEventListener('message', receive);
    };
  }, [post, launchAssistant]);
  useEffect(() => {
    if (mounted.current) void latest.current();
  }, [locale, route]);
  if (!src) return <p>{t('app.extensionUnavailable')}</p>;
  return (
    <section className="flex h-full min-h-0 flex-col" data-testid="extension-embed-host">
      <h1 className="px-4 py-2 text-base font-semibold">{title}</h1>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <iframe
        ref={frame}
        src={src}
        title={title}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        className="min-h-0 w-full flex-1 border-0"
        onLoad={() => void latest.current()}
      />
    </section>
  );
}
