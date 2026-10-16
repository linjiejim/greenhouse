import { useEffect, useMemo, useRef } from 'react';
import type { AppCard, AppRuntime } from '@greenhouse/contract';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { CARD_THEME_TOKENS, cardDocument } from './sandbox';

export function CustomCard({ card, runtime }: { card: Extract<AppCard, { kind: 'custom' }>; runtime: AppRuntime }) {
  const { t, locale } = useI18n();
  const frame = useRef<HTMLIFrameElement>(null);
  const src = useMemo(() => cardDocument(card.html), [card.html]);
  const approved = runtime.custom_review === 'approved' && !runtime.preview;
  useEffect(() => {
    if (!approved) return;
    let live = true;
    let count = 0;
    let windowStart = Date.now();
    let busy = false;
    const context = () => ({
      locale,
      theme:
        document.documentElement.dataset.theme ??
        (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
      styles: {
        variables: Object.fromEntries(
          CARD_THEME_TOKENS.map((key) => [
            key,
            getComputedStyle(document.documentElement).getPropertyValue(key).trim(),
          ]),
        ),
      },
    });
    const changed = () =>
      frame.current?.contentWindow?.postMessage(
        { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: context() },
        '*',
      );
    const observer = new MutationObserver(changed);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', changed);
    const receive = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return;
      const message = event.data;
      if (
        !message ||
        message.jsonrpc !== '2.0' ||
        !['string', 'number'].includes(typeof message.id) ||
        String(message.id).length > 80
      )
        return;
      if (Date.now() - windowStart >= 60_000) {
        count = 0;
        windowStart = Date.now();
      }
      const respond = (answer: object) => {
        if (live) frame.current?.contentWindow?.postMessage({ jsonrpc: '2.0', id: message.id, ...answer }, '*');
      };
      if (++count > 30 || busy) {
        respond({ error: { code: -32000, message: t('apps.bridgeBusy') } });
        return;
      }
      if (message.method === 'ui/initialize') {
        respond({ result: { hostContext: context() } });
        return;
      }
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (
        message.method !== 'tools/call' ||
        typeof name !== 'string' ||
        !name.startsWith('query.') ||
        !args ||
        typeof args !== 'object' ||
        Object.keys(args).some((k) => k !== 'cursor') ||
        (args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > 2000))
      )
        return;
      const binding = name.slice(6);
      if (!card.bindings?.some((b) => b.id === binding)) {
        respond({ error: { code: -32601, message: t('apps.bindingDenied') } });
        return;
      }
      busy = true;
      try {
        const result = await api.apps.binding(runtime.app.id, runtime.version, card.id, binding, args.cursor);
        respond({ result });
      } catch {
        respond({ error: { code: -32001, message: t('apps.bindingDenied') } });
      } finally {
        busy = false;
      }
    };
    window.addEventListener('message', receive);
    return () => {
      live = false;
      observer.disconnect();
      media.removeEventListener('change', changed);
      window.removeEventListener('message', receive);
    };
  }, [approved, card.id, card.bindings, runtime.app.id, runtime.version, locale, t]);
  if (!approved) return <p>{t('apps.customDisabled')}</p>;
  return (
    <iframe
      className="app-custom-card"
      ref={frame}
      title={card.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
      srcDoc={src}
      style={{ height: card.height ?? 320 }}
    />
  );
}
