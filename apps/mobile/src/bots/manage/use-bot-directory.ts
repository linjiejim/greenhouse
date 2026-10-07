/**
 * The member's Bot list for a management screen (profile, Bot form, new
 * group, Settings → My Bots): asks the store for it when it has not arrived
 * yet (`fresh`: re-read on every visit even when it has), and reports a
 * failure only once that ask came back without it — an earlier, unrelated
 * failure in the store must not flash a retry over a load still in flight.
 */

import { useCallback, useEffect, useState } from 'react';
import { useBots } from '../store';

export function useBotDirectory(opts: { fresh?: boolean } = {}): {
  loaded: boolean;
  failed: boolean;
  retry: () => void;
} {
  const loaded = useBots((s) => s.botsLoaded);
  const loadBots = useBots((s) => s.loadBots);
  const [asked, setAsked] = useState(false);
  const { fresh = false } = opts;

  const ask = useCallback(() => {
    setAsked(false);
    void loadBots().then(() => setAsked(true));
  }, [loadBots]);

  useEffect(() => {
    if (fresh || !useBots.getState().botsLoaded) ask();
  }, [fresh, ask]);

  return { loaded, failed: asked && !loaded, retry: ask };
}
