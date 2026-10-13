/**
 * The message column: oldest at the top, newest at the bottom, centred at 760. It follows new
 * messages while the reader is at the bottom and otherwise offers "jump to latest"; scrolling up
 * loads older pages without moving what is on screen.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import { Button, Spinner } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { useT } from '../lib/i18n';

const NEAR_BOTTOM = 120;

export function Thread({
  children,
  /** Changes whenever the last message changes or grows (id + length): keeps the view pinned. */
  tail,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  header,
}: {
  children: ReactNode;
  tail: string;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  header?: ReactNode;
}) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const restore = useRef<number | null>(null);
  const [away, setAway] = useState(false);

  const toBottom = useCallback((smooth = false) => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    pinned.current = true;
    setAway(false);
  }, []);

  // New or growing tail: stay at the bottom if we were there.
  useLayoutEffect(() => {
    if (restore.current !== null) return;
    if (pinned.current) toBottom();
    else setAway(true);
  }, [tail, toBottom]);

  // Older messages arrived above: keep the same message under the reader's eye.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || restore.current === null || loadingOlder) return;
    element.scrollTop = element.scrollHeight - restore.current;
    restore.current = null;
  });

  // Anything that grows the column (a card arriving, an image loading) keeps a pinned view pinned.
  const column = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = column.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current && restore.current === null) toBottom();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [toBottom]);

  useEffect(() => {
    const element = sentinel.current;
    const root = scroller.current;
    if (!element || !root || !hasOlder) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || loadingOlder) return;
        restore.current = root.scrollHeight - root.scrollTop;
        onLoadOlder();
      },
      { root, rootMargin: '200px 0px 0px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasOlder, loadingOlder, onLoadOlder]);

  return (
    <div
      className="app-thread"
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        const near = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM;
        pinned.current = near;
        if (near) setAway(false);
      }}
    >
      <div className="app-thread-column" ref={column}>
        {hasOlder && (
          <div ref={sentinel} className="app-thread-older" aria-live="polite">
            {loadingOlder && <Spinner />}
          </div>
        )}
        {header}
        {children}
      </div>
      {away && (
        <div className="app-jump">
          <Button size="sm" onClick={() => toBottom(true)}>
            <ArrowDown size={icon.sm} />
            {t('message.jumpToLatest')}
          </Button>
        </div>
      )}
    </div>
  );
}
