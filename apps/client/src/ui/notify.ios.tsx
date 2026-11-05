/**
 * iOS notices: confirmations are the glass HUD (./toast.ios.tsx), Undo is the HUD with its action,
 * and a failure is the system alert (platform rule, DESIGN.md Relation to jim-uiux).
 */
import { Alert } from 'react-native';
import { toast, toastWithAction } from './toast';
import { alertError } from './dialogs';
import { translate } from '../lib/i18n';
import { usePrefs } from '../store/prefs';
import type { NotifyApi, NotifyOptions } from './notify-types';

const tr = (key: 'common.undo' | 'common.ok') => translate(usePrefs.getState().lang, key);
const done = () => () => {};

function plain(icon: 'checkCircle' | 'alertCircle' | 'alert') {
  return (text: string, options?: NotifyOptions) => {
    if (options?.action) toastWithAction(text, { ...options.action, onDismiss: options.onDismiss }, 6000, icon);
    else toast(text, icon);
    return done();
  };
}

function error(text: string, options?: NotifyOptions) {
  if (options?.action) {
    const action = options.action;
    Alert.alert(
      text,
      options.body,
      [
        { text: tr('common.ok'), style: 'cancel', onPress: options.onDismiss },
        { text: action.label, onPress: action.onPress },
      ],
      { cancelable: true, onDismiss: options.onDismiss },
    );
  } else alertError(text, options?.body, options?.detail);
  return done();
}

export const notify: NotifyApi = Object.assign(plain('checkCircle'), {
  success: plain('checkCircle'),
  info: plain('alertCircle'),
  warning: plain('alert'),
  undo: (text: string, onUndo: () => void, options?: NotifyOptions) => {
    toastWithAction(text, { label: tr('common.undo'), onPress: onUndo, onDismiss: options?.onDismiss }, 8000, 'checkCircle');
    return done();
  },
  error,
});

/** The HUD host (ToastHost) draws notices; nothing else to mount. */
export function NotifyHost(): null {
  return null;
}
