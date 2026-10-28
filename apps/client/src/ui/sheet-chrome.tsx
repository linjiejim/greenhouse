import { useFormGuard } from './form-guard';
import { ScreenActions } from './screen-actions';

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
 */

import React from 'react';

import { Stack, useRouter } from 'expo-router';
import { useT } from '../lib/i18n';

import { SheetActions } from './sheet-actions';
import { NativeButton } from './button';

/** ✕ close on the left of a sheet's navigation bar. Defaults to `router.back()`. */
export function SheetClose({ onPress }: { onPress?: () => void }) {
  const t = useT();
  const router = useRouter();
  return (
    <ScreenActions
      placement={'left'}
      actions={[
        { id: 'action-1', icon: 'x' as const, label: t('common.close'), onPress: onPress ?? (() => router.back()) },
      ]}
    />
  );
}

/** Ask before throwing away unsaved edits (system alert, destructive 放弃). */
export { confirmDiscard } from './form-guard';

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
  const { t, cancel, sameIdentity } = useFormGuard({
    title,
    dirty,
    canSave,
    saving,
    onSave,
    onCancel,
    protectNavigation,
  });

  return (
    <>
      <Stack.Screen options={{ title, gestureEnabled: !dirty && !saving, headerBackButtonMenuEnabled: false }} />
      <ScreenActions
        placement={'left'}
        actions={[
          {
            id: 'action-2',
            icon: 'x' as const,
            label: t('common.cancel'),
            onPress: () => void cancel(),
            disabled: saving,
          },
        ]}
      />
      <ScreenActions
        placement={'right'}
        actions={[
          ...(onReload
            ? [
                {
                  id: 'action-3',
                  icon: 'refresh' as const,
                  label: t('common.reload'),
                  onPress: onReload,
                  disabled: saving || !sameIdentity,
                },
              ]
            : []),
        ]}
      />
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
