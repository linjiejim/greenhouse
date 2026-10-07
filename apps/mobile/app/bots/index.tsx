/**
 * `greenhouse://bots[?c=&request=&compose=]` — the Bots deep-link entry
 * (spec docs/specs/20261008-mobile-bots.md §2.4). Renders nothing: it pops
 * back to the one home (`dismissTo`, never a second `(drawer)`) and points it
 * at the thread — `c`'s, or Sprouty's when none is given (bootstrapping
 * Sprouty's DM first when it has none yet). `request` scrolls the thread to
 * that card, `compose=1` focuses its composer.
 *
 * Closed doors go home as they are: with Bots off, refused or on an older
 * server the member gets "Bots aren't available"; on Android (no Bots
 * surfaces in v1, §2.9) the link quietly lands on home.
 */

import { useEffect } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { BOTS_PLATFORM_READY, botsEnabledNow } from '../../src/bots/availability';
import { openThread } from '../../src/bots/nav';
import { sproutyBot, useBots } from '../../src/bots/store';
import { t } from '../../src/lib/i18n';
import { alertError } from '../../src/ui/dialogs';

export default function BotsDeepLink() {
  const router = useRouter();
  const { c, request, compose } = useLocalSearchParams<{ c?: string; request?: string; compose?: string }>();
  useEffect(() => {
    let live = true;
    const unavailable = () => {
      router.dismissTo('/');
      if (BOTS_PLATFORM_READY) alertError(t('bots.nav.unavailable'));
    };
    if (!BOTS_PLATFORM_READY || !botsEnabledNow()) {
      unavailable();
      return;
    }
    const thread = { request: request ? String(request) : '', compose: compose === '1' };
    if (c) {
      openThread(router, { c: String(c), ...thread }, 'dismissTo');
      return;
    }
    void useBots
      .getState()
      .ensureSprouty()
      .then((sid) => {
        if (!live) return;
        if (!sid) {
          unavailable();
          return;
        }
        openThread(router, { c: sid, title: sproutyBot(useBots.getState())?.name ?? '', ...thread }, 'dismissTo');
      });
    return () => {
      live = false;
    };
  }, [router, c, request, compose]);
  return null;
}
