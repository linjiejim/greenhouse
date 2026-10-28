import React, { useContext, useEffect, useRef } from 'react';
import { SettingsWindowContext } from './settings-frame';
import { Text, View } from 'react-native';
import { Stack, useIsFocused, useRouter } from 'expo-router';
import { Controls, ScreenActions } from './screen-actions.web';
import { useFormGuard, type FormChromeProps } from './form-guard';
import { NativeButton } from './button';
import { Icon } from './core';
import { DialogFrameContext } from './dialog-frame';
import { hasInteractiveOverlay } from './overlay.web';
import { SheetActions } from './sheet-actions';
import { useT } from '../lib/i18n';
import { typo, useTheme } from '../theme';
export { confirmDiscard } from './form-guard';
export function SheetClose({ onPress }: { onPress?: () => void }) {
  const t = useT();
  const router = useRouter();
  return (
    <>
      <Stack.Screen options={{ headerShown: true }} />
      <ScreenActions
        placement="left"
        actions={[{ id: 'close', icon: 'x', label: t('common.close'), onPress: onPress ?? (() => router.back()) }]}
      />
    </>
  );
}
/** Inputs where Enter means "done" (a textarea's Enter is a new line; ⌘/Ctrl+Enter submits from anywhere). */
const SUBMITS_ON_ENTER = /^(text|search|email|url|tel|number|date|time|datetime-local|month|week|password)$/;

export function FormChrome(props: FormChromeProps) {
  const guard = useFormGuard(props);
  const inDialog = useContext(DialogFrameContext);
  const inSettingsWindow = useContext(SettingsWindowContext);
  return inDialog || inSettingsWindow ? (
    <DialogChrome {...props} {...guard} inSettingsWindow={inSettingsWindow} />
  ) : (
    <SheetChrome {...props} {...guard} inSettingsWindow={inSettingsWindow} />
  );
}

type ChromeProps = FormChromeProps & ReturnType<typeof useFormGuard> & { inSettingsWindow: boolean };

/**
 * A wide window: the desktop form dialog (apps/client/DESIGN.md) — one title bar with ✕, the form,
 * and a footer with Cancel and the primary action at the trailing end. Enter in a field submits,
 * Esc cancels; both, like ✕ and Cancel, ask before throwing edits away. The settings window draws
 * its own close button and closes itself, so there the footer holds only the primary action.
 */
function DialogChrome(props: ChromeProps) {
  const { t, cancel, sameIdentity, inSettingsWindow } = props;
  const focused = useIsFocused();
  const header = useRef<HTMLDivElement>(null);
  const canSubmit = sameIdentity && props.canSave && !props.saving;
  const latest = useRef({ cancel, submit: () => {} });
  latest.current = { cancel, submit: () => (canSubmit && !props.hideSave ? props.onSave() : undefined) };
  useEffect(() => {
    if (!focused) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || hasInteractiveOverlay()) return;
      const target = event.target instanceof Element ? event.target : null;
      if (event.key === 'Escape' && !inSettingsWindow) {
        // before the sheet frame's own Esc, which would close without the discard question
        event.preventDefault();
        event.stopImmediatePropagation();
        void latest.current.cancel();
        return;
      }
      const inForm = !!target && !!header.current?.parentElement?.contains(target);
      if (
        event.key === 'Enter' &&
        inForm &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        target instanceof HTMLInputElement &&
        SUBMITS_ON_ENTER.test(target.type)
      ) {
        event.preventDefault();
        latest.current.submit();
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [focused, inSettingsWindow]);
  return (
    <>
      <Stack.Screen options={{ headerShown: false, title: props.title }} />
      <div ref={header} className="gh-dialog-header">
        <strong role="heading" aria-level={2}>
          {props.title}
        </strong>
        {props.onReload ? (
          <button
            type="button"
            className="gh-icon-button"
            aria-label={t('common.reload')}
            disabled={props.saving || !sameIdentity}
            onClick={props.onReload}
          >
            <Icon name="refresh" size={18} />
          </button>
        ) : null}
        {inSettingsWindow ? null : (
          <button
            type="button"
            className="gh-icon-button"
            aria-label={t('common.close')}
            disabled={props.saving}
            onClick={() => void cancel()}
          >
            <Icon name="x" size={18} />
          </button>
        )}
      </div>
      {!props.hideSave ? (
        <SheetActions bare>
          <div className="gh-dialog-footer">
            {inSettingsWindow ? null : (
              <button
                type="button"
                className="gh-secondary-button"
                disabled={props.saving}
                onClick={() => void cancel()}
              >
                {t('common.cancel')}
              </button>
            )}
            <button
              type="button"
              className="gh-primary"
              disabled={!sameIdentity || !props.canSave || props.saving}
              aria-busy={props.saving || undefined}
              onClick={() => latest.current.submit()}
            >
              {props.saveLabel ?? t('common.save')}
            </button>
          </div>
        </SheetActions>
      ) : null}
    </>
  );
}

/** A phone-width window: the sheet's title row with ✕ and a full-width primary action at the bottom. */
function SheetChrome(props: ChromeProps) {
  const { t, cancel, sameIdentity, inSettingsWindow } = props;
  const { hex: c } = useTheme();
  return (
    <>
      <Stack.Screen options={{ headerShown: false, title: props.title }} />
      <View
        style={{
          height: 52,
          flexDirection: 'row',
          alignItems: 'center',
          borderBottomWidth: 1,
          borderColor: c.separator,
          paddingLeft: 16,
        }}
      >
        <Text accessibilityRole="header" style={{ ...typo.title3, color: c.label, flex: 1 }}>
          {props.title}
        </Text>
        <Controls
          actions={[
            ...(props.onReload
              ? [
                  {
                    id: 'reload',
                    icon: 'refresh' as const,
                    label: t('common.reload'),
                    onPress: props.onReload,
                    disabled: props.saving || !sameIdentity,
                  },
                ]
              : []),
            ...(inSettingsWindow
              ? []
              : [
                  {
                    id: 'cancel',
                    icon: 'x' as const,
                    label: t('common.cancel'),
                    onPress: () => void cancel(),
                    disabled: props.saving,
                  },
                ]),
          ]}
        />
      </View>
      {!props.hideSave ? (
        <SheetActions>
          {/* full width in an inspector; the form's own width on a wide settings page */}
          <View style={{ width: '100%', maxWidth: 632, alignSelf: 'center' }}>
            <NativeButton
              label={props.saveLabel ?? t('common.save')}
              variant="prominent"
              size="large"
              fullWidth
              disabled={!sameIdentity || !props.canSave}
              loading={props.saving}
              onPress={() => {
                if (sameIdentity && props.canSave && !props.saving) props.onSave();
              }}
            />
          </View>
        </SheetActions>
      ) : null}
    </>
  );
}
