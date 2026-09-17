import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { readCoworkerMessages } from '../../lib/api/coworkers';

/** Viewport receipts are independent from selecting an Agent or opening a topic. */
export function useCoworkerReading({
  enabled,
  userId,
  sessionId,
  loading,
  messages,
  root,
  atBottom,
}: {
  enabled: boolean;
  userId?: string;
  sessionId: string | null;
  loading: boolean;
  messages: Array<{ id: string; role: string; content: string }>;
  root: RefObject<HTMLDivElement | null>;
  atBottom: RefObject<boolean>;
}) {
  const restored = useRef<string | null>(null);
  const messageVersion = messages.map((m) => m.id).join(',');
  const key = `coworker-scroll:${userId}:${sessionId}`;
  useLayoutEffect(() => {
    const element = root.current;
    if (!enabled || !sessionId || loading || !element || restored.current === sessionId) return;
    restored.current = sessionId;
    const message = new URLSearchParams(window.location.hash.split('?')[1]).get('message');
    const target = message ? document.getElementById(`coworker-message-${message}`) : null;
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(key);
    } catch {
      /* unavailable */
    }
    if (target) target.scrollIntoView({ block: 'start' });
    else element.scrollTop = saved !== null && Number.isFinite(Number(saved)) ? Number(saved) : element.scrollHeight;
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  }, [enabled, sessionId, loading, messageVersion, key, root, atBottom]);

  useEffect(() => {
    const element = root.current;
    if (!enabled || !sessionId || !element) return;
    const save = () => {
      // Passive cleanup can run after React detaches the old scroll container;
      // detached elements report zero and must not overwrite the saved position.
      if (restored.current !== sessionId || !element.isConnected) return;
      try {
        sessionStorage.setItem(key, String(element.scrollTop));
      } catch {
        /* unavailable */
      }
    };
    element.addEventListener('scroll', save, { passive: true });
    return () => {
      save();
      element.removeEventListener('scroll', save);
    };
  }, [enabled, sessionId, key, root]);

  useEffect(() => {
    const element = root.current;
    if (!enabled || !sessionId || loading || !element || typeof IntersectionObserver === 'undefined') return;
    let disposed = false;
    const seen = new Set<string>();
    const visible = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = async () => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      const ids = [...visible].filter((id) => !seen.has(id)).slice(0, 100);
      if (!ids.length) return;
      ids.forEach((id) => seen.add(id));
      try {
        await readCoworkerMessages(sessionId, ids);
        if (!disposed) window.dispatchEvent(new Event('coworker:read'));
      } catch {
        ids.forEach((id) => seen.delete(id));
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), 500);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.coworkerMessage!;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        schedule();
      },
      { root: element, threshold: 0 },
    );
    element.querySelectorAll('[data-coworker-message]').forEach((node) => observer.observe(node));
    window.addEventListener('focus', schedule);
    document.addEventListener('visibilitychange', schedule);
    const retry = setInterval(schedule, 10000);
    return () => {
      disposed = true;
      observer.disconnect();
      clearTimeout(timer);
      clearInterval(retry);
      window.removeEventListener('focus', schedule);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [enabled, sessionId, loading, messageVersion, root]);
}
