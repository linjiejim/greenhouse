/**
 * System dialogs as promises — UIAlertController under the hood, so they get
 * the native look, Liquid Glass, keyboard handling and accessibility.
 *
 *  - `confirmAction()` — a yes/no question; `destructive` styles the confirm
 *    button red (deleting, discarding, signing out).
 *  - `promptText()`    — a single text field (rename, create a tag).
 *  - `alertError()`    — the ONE way to report a failed action (see below);
 *    a raw technical reason goes in its `detail` (behind 详情), never the message.
 *
 * Feedback policy (one rule, app-wide):
 *  - an action the user asked for failed (save / delete / create / restore /
 *    rename / send / add member / change status — including optimistic updates
 *    that were rolled back) → `alertError(t('….saveFailed'))`: a system alert
 *    with a single OK, so the failure can't be missed;
 *  - a limit or rule explains why nothing happened (tag limits…) →
 *    `alertError(title, message)` as well;
 *  - success confirmations → `toast(msg, icon)` (src/ui/toast.tsx) — never
 *    for failures;
 *  - a screen that failed to load → an in-screen `EmptyState` with 重试.
 *
 * Never build a custom modal for these. Android: ./dialogs.android.tsx — the
 * same API as Material 3 dialogs, shown by `DialogHost` (mounted at the root;
 * nothing to show on iOS).
 */

import { Alert } from 'react-native';
import { translate } from '../lib/i18n';
import { usePrefs } from '../store/prefs';

function tr(key: 'common.cancel' | 'common.ok' | 'common.details'): string {
  return translate(usePrefs.getState().lang, key);
}

export function confirmAction(opts: {
  title: string;
  message?: string;
  confirmLabel: string;
  /** Override the 取消 label (e.g. 继续编辑 for a discard prompt). */
  cancelLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      opts.title,
      opts.message,
      [
        { text: opts.cancelLabel ?? tr('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: opts.confirmLabel, style: opts.destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/**
 * Report a failed action: system alert, title + optional message, single OK.
 * `detail` — the technical reason (a provider's raw answer): kept out of the
 * message, one tap away behind 详情.
 */
export function alertError(title: string, message?: string, detail?: string): void {
  const ok = { text: tr('common.ok') };
  Alert.alert(
    title,
    message || undefined,
    detail
      ? [{ text: tr('common.details'), onPress: () => Alert.alert(tr('common.details'), detail, [ok]) }, ok]
      : [ok],
  );
}

export function promptText(opts: {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** A secret (an API key): the field hides what is typed. */
  secure?: boolean;
}): Promise<string | null> {
  return new Promise((resolve) => {
    Alert.prompt(
      opts.title,
      opts.message,
      [
        { text: tr('common.cancel'), style: 'cancel', onPress: () => resolve(null) },
        { text: opts.confirmLabel ?? tr('common.ok'), onPress: (value?: string) => resolve((value ?? '').trim() || null) },
      ],
      opts.secure ? 'secure-text' : 'plain-text',
      opts.defaultValue,
    );
  });
}

/** iOS dialogs are UIAlertControllers — nothing to mount (Android: Material dialogs host). */
export function DialogHost(): null {
  return null;
}
