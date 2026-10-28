/**
 * Transient confirmations on Android — the system toast (`ToastAndroid`), the
 * platform's own short message at the bottom of the screen. Same API as
 * ./toast.tsx (iOS: a glass HUD under the status bar). Copy confirmations are
 * skipped on Android 13+, where the system already confirms every clipboard
 * write with its own overlay.
 */
import { Platform, ToastAndroid } from 'react-native';
import type { IconName } from './core';
import { selectionTick } from './haptics';

/** Show a short confirmation. Safe to call from anywhere (not a hook). */
export function toast(message: string, icon?: IconName): void {
  if (icon === 'copy' && typeof Platform.Version === 'number' && Platform.Version >= 33) return;
  selectionTick();
  ToastAndroid.show(message, ToastAndroid.SHORT);
}

/** The system draws toasts — nothing to mount. */
export function ToastHost(): null {
  return null;
}
