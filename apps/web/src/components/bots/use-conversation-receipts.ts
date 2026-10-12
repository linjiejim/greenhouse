import { useEffect, useRef, useState, type RefObject } from 'react';
import type { BotMessage } from '@greenhouse/types/bots';
import { getConversationReceipts, markConversationRead, type ConversationReceipts } from '../../lib/api/bots';
import { wsClient } from '../../lib/ws';

/** Receipt updates never reload the transcript; only visible message ends advance the reader. */
export function useConversationReceipts(
  sessionId: string,
  enabled: boolean,
  messages: readonly BotMessage[],
  root: RefObject<HTMLDivElement | null>,
): ConversationReceipts {
  const [receipts, setReceipts] = useState<ConversationReceipts>({ people: [], agents: [] });
  const through = useRef(-1);
  useEffect(() => {
    through.current = -1;
    setReceipts({ people: [], agents: [] });
    if (!enabled) return;
    let live = true;
    let revision = 0;
    const refresh = async () => {
      const ticket = ++revision;
      try {
        const next = await getConversationReceipts(sessionId);
        if (live && revision === ticket) setReceipts(next);
      } catch {
        /* A deleted/left room no longer exposes receipts. */
      }
    };
    void refresh();
    const unsubscribe = wsClient.onEvent((event) => {
      if (event.type === 'bots:receipts' && event.sessionId === sessionId) void refresh();
    });
    const reconnect = wsClient.onStatusChange((status) => {
      if (status === 'connected') void refresh();
    });
    return () => {
      live = false;
      unsubscribe();
      reconnect();
    };
  }, [enabled, sessionId]);

  useEffect(() => {
    const container = root.current;
    if (!enabled || !container || typeof IntersectionObserver === 'undefined') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    const byId = new Map(messages.map((message) => [message.id, message]));
    const flush = () => {
      if (!live || pending || document.visibilityState !== 'visible') return;
      const bounds = container.getBoundingClientRect();
      let latest: BotMessage | undefined;
      for (const node of container.querySelectorAll<HTMLElement>('[data-receipt-end]')) {
        const rect = node.getBoundingClientRect();
        if (
          rect.bottom <= bounds.top ||
          rect.top >= bounds.bottom ||
          rect.bottom <= 0 ||
          rect.top >= window.innerHeight
        )
          continue;
        const message = byId.get(node.dataset.receiptEnd ?? '');
        if (message && message.seq > through.current && (!latest || message.seq > latest.seq)) latest = message;
      }
      if (!latest) return;
      const shown = latest;
      pending = true;
      let acknowledged = false;
      void markConversationRead(sessionId, shown.id)
        .then(() => {
          if (live) {
            through.current = Math.max(through.current, shown.seq);
            acknowledged = true;
          }
        })
        .catch(() => {})
        .finally(() => {
          pending = false;
          // A scroll during the request may have exposed a newer message.
          if (live && acknowledged) schedule();
        });
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(flush, 150);
    };
    const observer = new IntersectionObserver(schedule, { root: container, threshold: 0 });
    for (const node of container.querySelectorAll('[data-receipt-end]')) observer.observe(node);
    document.addEventListener('visibilitychange', schedule);
    container.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => {
      live = false;
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', schedule);
      container.removeEventListener('scroll', schedule);
    };
  }, [enabled, messages, root, sessionId]);
  return receipts;
}
