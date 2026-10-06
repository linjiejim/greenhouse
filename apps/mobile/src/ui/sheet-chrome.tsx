/**
 * Shared chrome for sheet / modal routes — the navigation-bar pieces every
 * presented screen repeats. Render them inside the screen (they declare
 * `Stack.Screen` options / `Stack.Toolbar` items for the screen they're in):
 *
 *  - `<SheetClose />` — the ✕ on the left that closes a peek / picker / viewer.
 *  - `<FormChrome … />` — title + ✕ cancel / ✓ save for create / edit forms:
 *    ✕ asks before discarding when there are unsaved edits, ✓ is the accent
 *    "done" button (disabled until `canSave`, and while `saving`), and the
 *    swipe-to-dismiss gesture is blocked while dirty so an accidental swipe
 *    never loses edits.
 *  - `useLeaveSheetTo()` — "open the full page" from a sheet: dismiss the
 *    sheet first, then push the page onto the stack underneath (pushing while
 *    the sheet is up would stack the page *inside* the sheet's presentation).
 */

import React, { useCallback } from 'react';
import { Stack, useRouter, type Href } from 'expo-router';
import { useT } from '../lib/i18n';
import { useTheme } from '../theme';
import { confirmAction } from './dialogs';

/** ✕ close on the left of a sheet's navigation bar. Defaults to `router.back()`. */
export function SheetClose({ onPress }: { onPress?: () => void }) {
  const t = useT();
  const router = useRouter();
  return (
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button icon="xmark" accessibilityLabel={t('common.close')} onPress={onPress ?? (() => router.back())} />
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
 * Title + ✕ / ✓ for a create / edit form presented as a sheet or modal.
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
}: {
  title: string;
  dirty: boolean;
  canSave: boolean;
  saving?: boolean;
  onSave: () => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const { hex } = useTheme();

  const cancel = useCallback(async () => {
    if (dirty && !(await confirmDiscard(t))) return;
    if (onCancel) onCancel();
    else router.back();
  }, [dirty, t, router, onCancel]);

  return (
    <>
      <Stack.Screen options={{ title, gestureEnabled: !dirty && !saving }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon="xmark"
          disabled={saving}
          accessibilityLabel={t('common.cancel')}
          onPress={() => void cancel()}
        />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="checkmark"
          variant="done"
          tintColor={hex.accent}
          disabled={!canSave || saving}
          accessibilityLabel={t('common.save')}
          onPress={() => {
            if (canSave && !saving) onSave();
          }}
        />
      </Stack.Toolbar>
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
