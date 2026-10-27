import React, { useContext } from 'react';
import { SettingsWindowContext } from './settings-frame';
import { Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Controls, ScreenActions } from './screen-actions.web';
import { useFormGuard, type FormChromeProps } from './form-guard';
import { NativeButton } from './button';
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
export function FormChrome(props: FormChromeProps) {
  const { t, cancel, sameIdentity } = useFormGuard(props);
  const { hex: c } = useTheme();
  const inSettingsWindow = useContext(SettingsWindowContext);
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
