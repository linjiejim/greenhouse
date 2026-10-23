/**
 * The soft ask: never over the launch screen or the sign-in — once the member's notifications
 * are on screen (the station pushes, the system was never asked), ask in our words whether to be
 * told on this phone. Only "Allow" brings up the system prompt, and pushes are then on for this
 * station; "Later" waits 14 days before asking again (Settings → Notifications is always there).
 * A system alert, like every question this app asks.
 */

import { t } from '../lib/i18n';
import { loadPref, savePref } from '../api/token-storage';
import { AFTER_DISMISS_MS } from '../store/auth';
import { confirmAction } from '../ui/dialogs';
import { softAskDue } from './model';
import { PUSH_PLATFORM_READY, readPermission, requestPushPermission, usePush } from './register';

const ASKED_PREF = 'push_soft_ask_at';
let asking = false;

/** Call once the member's notifications are on screen; asks at most once per 14 days. */
export async function softAskWhenSettled(): Promise<void> {
  if (!PUSH_PLATFORM_READY || asking) return;
  asking = true;
  try {
    const [permission, raw] = await Promise.all([readPermission(), loadPref(ASKED_PREF)]);
    const lastAskedAt = raw ? Number(raw) : null;
    const due = softAskDue({
      permission,
      supported: usePush.getState().support === 'enabled',
      lastAskedAt: Number.isFinite(lastAskedAt) ? lastAskedAt : null,
      now: Date.now(),
    });
    if (!due) return;
    // let the screen settle first: an alert raised during a transition can go with it
    await new Promise((resolve) => setTimeout(resolve, AFTER_DISMISS_MS + 620));
    await savePref(ASKED_PREF, String(Date.now()));
    const yes = await confirmAction({
      title: t('push.softAskTitle'),
      message: t('push.softAskMessage'),
      confirmLabel: t('push.softAskAllow'),
      cancelLabel: t('push.softAskLater'),
    });
    if (yes) await requestPushPermission();
  } finally {
    asking = false;
  }
}
