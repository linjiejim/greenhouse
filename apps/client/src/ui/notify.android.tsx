/** Android notices: the system toast for confirmations; actions (Undo, Retry) need a dialog there. */
import { Alert } from 'react-native';
import { toast } from './toast.android';
import { alertError } from './dialogs.android';
import { translate } from '../lib/i18n';
import { usePrefs } from '../store/prefs';
import type { NotifyApi, NotifyOptions } from './notify-types';

const tr = (key: 'common.undo' | 'common.ok') => translate(usePrefs.getState().lang, key);
const done = () => () => {};

function withAction(text: string, action: { label: string; onPress: () => void }) {
  Alert.alert(text, undefined, [
    { text: tr('common.ok'), style: 'cancel' },
    { text: action.label, onPress: action.onPress },
  ]);
}

function plain(text: string, options?: NotifyOptions) {
  if (options?.action) withAction(text, options.action);
  else toast(text);
  return done();
}

export const notify: NotifyApi = Object.assign(plain, {
  success: plain,
  info: plain,
  warning: plain,
  undo: (text: string, onUndo: () => void) => {
    withAction(text, { label: tr('common.undo'), onPress: onUndo });
    return done();
  },
  error: (text: string, options?: NotifyOptions) => {
    if (options?.action) withAction(text, options.action);
    else alertError(text, undefined, options?.detail);
    return done();
  },
});

export function NotifyHost(): null {
  return null;
}
