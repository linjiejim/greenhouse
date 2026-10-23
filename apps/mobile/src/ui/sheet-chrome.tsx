import { usePreventRemove } from 'expo-router/react-navigation';
/**
 * Shared chrome for sheet / modal routes — the navigation-bar pieces every
 * presented screen repeats. Render them inside the screen (they declare
 * `Stack.Screen` options / `Stack.Toolbar` items for the screen they're in):
 *
 *  - `<SheetClose />` — the ✕ on the left that closes a peek / picker / viewer.
 *  - `<FormChrome … />` — title + ✕ cancel and a pinned primary save for create / edit forms:
 *    ✕ asks before discarding when there are unsaved edits; the footer holds the accent
 *    "done" button (disabled until `canSave`, and while `saving`), and the
 *    swipe-to-dismiss gesture is blocked while dirty so an accidental swipe
 *    never loses edits.
 *  - `useLeaveSheetTo()` — "open the full page" from a sheet: dismiss the
 *    sheet first, then push the page onto the stack underneath (pushing while
 *    the sheet is up would stack the page *inside* the sheet's presentation).
 */

import React, { useCallback, useRef } from 'react';
import { BackHandler, Keyboard, Platform } from 'react-native';
import { Stack, useFocusEffect, useNavigation, useRouter, type Href } from 'expo-router';
import { useT } from '../lib/i18n';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
import { SheetActions } from './sheet-actions';
import { NativeButton } from './button';
import { confirmAction } from './dialogs';
import { toolbarIcon } from './toolbar-icon';

/** ✕ close on the left of a sheet's navigation bar. Defaults to `router.back()`. */
export function SheetClose({ onPress }: { onPress?: () => void }) {
  const t = useT();
  const router = useRouter();
  return (
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button
        icon={toolbarIcon('x')}
        accessibilityLabel={t('common.close')}
        onPress={onPress ?? (() => router.back())}
      />
    </Stack.Toolbar>
  );
}

/** Ask before throwing away unsaved edits (system alert, destructive 放弃). */
export function confirmDiscard(t: ReturnType<typeof useT>): Promise<boolean> {
  return confirmAction({
    title: t('common.discardTitle'),
    message: t('common.discardHint'),
    confirmLabel: t('common.discard'),
    cancelLabel: t('common.keepEditing'),
    destructive: true,
  });
}

/**
 * Title, close guard and pinned primary action for a form presented as a sheet or modal.
 * `onSave` only fires when `canSave` and not `saving`; ✕ (and `onCancel`, if
 * given, instead of `router.back()`) runs after the discard check.
 */
export function FormChrome({
  title,
  dirty,
  canSave,
  saving = false,
  onSave,
  onCancel,
  saveLabel,
  protectNavigation = false,
  onReload,
  hideSave = false,
}: {
  title: string;
  dirty: boolean;
  canSave: boolean;
  saving?: boolean;
  onSave: () => void;
  onCancel?: () => void;
  /** What ✓ does, for VoiceOver when it is not "Save" (sign-in 登录). */
  saveLabel?: string;
  protectNavigation?: boolean;
  onReload?: () => void;
  hideSave?: boolean;
}) {
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

  return (
    <>
      <Stack.Screen options={{ title, gestureEnabled: !dirty && !saving, headerBackButtonMenuEnabled: false }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon={toolbarIcon('x')}
          disabled={saving}
          accessibilityLabel={t('common.cancel')}
          onPress={() => void cancel()}
        />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        {onReload ? (
          <Stack.Toolbar.Button
            icon={toolbarIcon('refresh')}
            accessibilityLabel={t('common.reload')}
            disabled={saving || !sameIdentity}
            onPress={onReload}
          />
        ) : null}
      </Stack.Toolbar>
      {!hideSave && (
        <SheetActions>
          <NativeButton
            label={saveLabel ?? t('common.save')}
            variant="prominent"
            size="large"
            fullWidth
            disabled={!sameIdentity || !canSave}
            loading={saving}
            onPress={() => {
              if (sameIdentity && canSave && !saving) onSave();
            }}
          />
        </SheetActions>
      )}
    </>
  );
}

/** Dismiss the presented sheet, then push `href` onto the stack underneath. */
export function useLeaveSheetTo(): (href: Href) => void {
  const router = useRouter();
  return useCallback(
    (href: Href) => {
      router.back();
      setTimeout(() => router.push(href), 0);
    },
    [router],
  );
}
