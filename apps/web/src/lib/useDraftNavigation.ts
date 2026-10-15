/** A draft asks before route changes as well as before closing its overlay. */
import { useLayoutEffect, useRef, useState } from 'react';
import { holdNavigation, leaveTo, type Attempt } from './router';

export function useDraftNavigation(dirty: boolean, busy: boolean, onDiscard: (navigating: boolean) => void) {
  const [asking, setAsking] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  const release = useRef<(() => void) | null>(null);
  const latest = useRef({ busy, onDiscard });
  latest.current = { busy, onDiscard };
  useLayoutEffect(() => {
    if (!dirty) return;
    const stop = holdNavigation((next) => {
      if (latest.current.busy) return;
      attempt.current = next;
      setAsking(true);
    });
    release.current = stop;
    return () => {
      stop();
      release.current = null;
    };
  }, [dirty]);
  return {
    asking,
    ask() {
      attempt.current = null;
      setAsking(true);
    },
    cancel() {
      attempt.current = null;
      setAsking(false);
    },
    discard() {
      const next = attempt.current;
      release.current?.();
      release.current = null;
      attempt.current = null;
      setAsking(false);
      latest.current.onDiscard(!!next);
      if (next) leaveTo(next);
    },
  };
}
