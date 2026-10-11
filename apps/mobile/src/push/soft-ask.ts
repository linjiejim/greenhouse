/**
 * The soft ask (spec docs/specs/20261010-mobile-push.md §2.3, D4): never at launch or
 * sign-in — the first time the member has just decided a "needs you" card in the app
 * (its sheet closing), ask in our words whether to be told even when away. Only "好"
 * brings up the system prompt; "以后再说" waits 14 days before asking again (Settings
 * → 通知 is always there). A system alert, like every question this app asks.
 */

import { t } from '../lib/i18n';
import { loadPref, savePref } from '../api/token-storage';
import { AFTER_DISMISS_MS } from '../store/auth';
import { confirmAction } from '../ui/dialogs';
import { softAskDue } from './model';
import { PUSH_PLATFORM_READY, readPermission, requestPushPermission, usePush } from './register';

const ASKED_PREF = 'push_soft_ask_at';
let asking = false;

/** Call right after a card's decision went through and its sheet started closing. */
export async function softAskAfterDecision(): Promise<void> {
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
    // let the decision sheet finish leaving: an alert raised under a closing sheet goes with it
    await new Promise((resolve) => setTimeout(resolve, AFTER_DISMISS_MS + 220));
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
