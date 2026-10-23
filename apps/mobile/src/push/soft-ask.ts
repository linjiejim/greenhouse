/**
 * The soft ask: never over the launch screen and never right after the sign-in (iOS's "Save
 * Password?" sheet comes then) — once the member's notifications are on screen on a later launch,
 * or the next time the app comes back to the foreground after signing in (the station pushes, the
 * system was never asked), ask in our words whether to be told on this phone. Only "Allow" brings up the system prompt, and pushes are then on for this
 * station; "Later" waits 14 days before asking again (Settings → Notifications is always there).
 * A system alert, like every question this app asks.
 */

import { t } from '../lib/i18n';
import { loadPref, savePref } from '../api/token-storage';
import { AppState } from 'react-native';
import { AFTER_DISMISS_MS, useAuth } from '../store/auth';
import { confirmAction } from '../ui/dialogs';
import { softAskDue } from './model';
import { PUSH_PLATFORM_READY, readPermission, requestPushPermission, usePush } from './register';

const ASKED_PREF = 'push_soft_ask_at';
let asking = false;
/** When the app last came to the foreground (module load = launch). */
let foregroundAt = Date.now();
AppState.addEventListener('change', (state) => {
  if (state === 'active') foregroundAt = Date.now();
});

/** Call once the member's notifications are on screen, and on every return to the foreground. */
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
      signedInAt: useAuth.getState().signedInAt,
      foregroundAt,
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
