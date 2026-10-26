import { useCallback, useRef } from 'react';
import { BackHandler, Keyboard, Platform } from 'react-native';
import { useFocusEffect, useNavigation, useRouter, useIsFocused } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
import { useT } from '../lib/i18n';
import { confirmAction } from './dialogs';
import { useShortcut } from './use-shortcut';
export interface FormChromeProps {
  title: string;
  dirty: boolean;
  canSave: boolean;
  saving?: boolean;
  onSave: () => void;
  onCancel?: () => void;
  saveLabel?: string;
  protectNavigation?: boolean;
  onReload?: () => void;
  hideSave?: boolean;
}
export function confirmDiscard(t: ReturnType<typeof useT>): Promise<boolean> {
  return confirmAction({
    title: t('common.discardTitle'),
    message: t('common.discardHint'),
    confirmLabel: t('common.discard'),
    cancelLabel: t('common.keepEditing'),
    destructive: true,
  });
}

export function useFormGuard({
  dirty,
  canSave,
  saving = false,
  onSave,
  onCancel,
  protectNavigation = false,
}: FormChromeProps) {
  const t = useT();
  const router = useRouter();
  const navigation = useNavigation();
  const member = useAuth((s) => s.user?.id);
  const station = useStations((s) => s.activeId);
  const owner = useRef({ member, station });
  const sameIdentity = owner.current.member === member && owner.current.station === station;
  const allowed = useRef(false);
  const confirming = useRef(false);
  usePreventRemove(protectNavigation && sameIdentity && (dirty || saving), ({ data }) => {
    if (saving) return;
    if (allowed.current) {
      allowed.current = false;
      navigation.dispatch(data.action);
      return;
    }
    if (confirming.current) return;
    confirming.current = true;
    Keyboard.dismiss();
    void confirmDiscard(t).then((ok) => {
      confirming.current = false;
      if (ok) navigation.dispatch(data.action);
    });
  });

  const cancel = useCallback(async () => {
    if (sameIdentity && dirty && !(await confirmDiscard(t))) return;
    allowed.current = true;
    if (onCancel) onCancel();
    else router.back();
  }, [dirty, t, router, onCancel, sameIdentity]);

  const focused = useIsFocused();
  useShortcut(
    'mod+Enter',
    () => {
      if (sameIdentity && canSave && !saving) onSave();
    },
    focused,
  );

  // Android: the system back button / gesture isn't covered by `gestureEnabled`
  // — with unsaved edits it goes through the same discard check as ✕. (Only
  // the system back: the screen's own `router.back()` after saving passes.)
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android' || !sameIdentity || !dirty || saving) return;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        void cancel();
        return true;
      });
      return () => sub.remove();
    }, [dirty, saving, cancel, sameIdentity]),
  );

  return { t, cancel, sameIdentity };
}
