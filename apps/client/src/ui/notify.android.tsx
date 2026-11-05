/** Android notices: the system toast for confirmations; actions (Undo, Retry) need a dialog there. */
import { Alert } from 'react-native';
import { toast } from './toast.android';
import { alertError } from './dialogs.android';
import { translate } from '../lib/i18n';
import { usePrefs } from '../store/prefs';
import type { NotifyApi, NotifyOptions } from './notify-types';

const tr = (key: 'common.undo' | 'common.ok') => translate(usePrefs.getState().lang, key);
const done = () => () => {};

function withAction(text: string, action: { label: string; onPress: () => void }, options?: NotifyOptions) {
  Alert.alert(
    text,
    options?.body,
    [
      { text: tr('common.ok'), style: 'cancel', onPress: options?.onDismiss },
      { text: action.label, onPress: action.onPress },
    ],
    { cancelable: true, onDismiss: options?.onDismiss },
  );
}

function plain(text: string, options?: NotifyOptions) {
  if (options?.action) withAction(text, options.action, options);
  else toast(text);
  return done();
}

export const notify: NotifyApi = Object.assign(plain, {
  success: plain,
  info: plain,
  warning: plain,
  undo: (text: string, onUndo: () => void, options?: NotifyOptions) => {
    withAction(text, { label: tr('common.undo'), onPress: onUndo }, options);
    return done();
  },
  error: (text: string, options?: NotifyOptions) => {
    if (options?.action) withAction(text, options.action, options);
    else alertError(text, options?.body, options?.detail);
    return done();
  },
});

export function NotifyHost(): null {
  return null;
}
