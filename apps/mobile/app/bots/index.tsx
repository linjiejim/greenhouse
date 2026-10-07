/**
 * `greenhouse://bots[?c=&request=&compose=]` — the Bots deep-link entry
 * (spec docs/specs/20261008-mobile-bots.md §2.4). Renders nothing: it pops
 * back to the one home (`dismissTo`, never a second `(drawer)`) and points it
 * at the thread — Sprouty's when no `c` is given.
 *
 * P0 STUB (package D implements it — the gate, bootstrapping Sprouty's
 * thread, the "unavailable" alert): forwards `c` / `request` / `compose` to
 * home as they are, or opens a new chat.
 */

import { useEffect } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { openNewChat, openThread } from '../../src/bots/nav';

export default function BotsDeepLink() {
  const router = useRouter();
  const { c, request, compose } = useLocalSearchParams<{ c?: string; request?: string; compose?: string }>();
  useEffect(() => {
    if (!c) {
      openNewChat(router, {}, 'dismissTo');
      return;
    }
    const thread = { c: String(c), request: request ? String(request) : '', compose: compose === '1' };
    openThread(router, thread, 'dismissTo');
  }, [router, c, request, compose]);
  return null;
}
