/**
 * Settings → 通知 on Android (iOS: ./notifications.tsx; both read
 * src/settings/use-push-settings.ts): this phone — pushes on this station, its switches per kind
 * of notification, previews and a test push.
 */

import React from 'react';
import { Linking } from 'react-native';
import { Stack } from 'expo-router';
import { useT } from '../../src/lib/i18n';
import { usePushSettings } from '../../src/settings/use-push-settings';
import {
  FormActionRow,
  FormSection,
  FormSwitchRow,
  FormValueRow,
  NativeForm,
  FormLoading,
} from '../../src/ui/native-form.android';

export default function SettingsNotifications() {
  const t = useT();
  const n = usePushSettings();
  return (
    <>
      <Stack.Screen options={{ title: t('settings.notifications') }} />
      <NativeForm>
        {n.pushes ? (
          <>
            <FormSection title={t('push.thisPhone')} footer={n.footer}>
              <FormSwitchRow
                label={t('push.enable')}
                value={n.phoneOn}
                onValueChange={(next) => void n.togglePhone(next)}
              />
              {n.systemOff ? (
                <FormActionRow
                  label={t('push.openSystemSettings')}
                  icon="gear"
                  onPress={() => void Linking.openSettings()}
                />
              ) : null}
            </FormSection>
            {n.phoneOn && n.prefs ? (
              <>
                <FormSection title={t('push.kinds')} footer={t('push.kindsFooter')}>
                  <FormSwitchRow
                    label={t('push.needsYou')}
                    value={n.prefs.needs_you}
                    onValueChange={(v) => void n.togglePhonePref('needs_you', v)}
                  />
                  <FormSwitchRow
                    label={t('push.done')}
                    value={n.prefs.done}
                    onValueChange={(v) => void n.togglePhonePref('done', v)}
                  />
                  <FormSwitchRow
                    label={t('push.other')}
                    value={n.prefs.other}
                    onValueChange={(v) => void n.togglePhonePref('other', v)}
                  />
                </FormSection>
                <FormSection footer={t('push.previewFooter')}>
                  <FormSwitchRow
                    label={t('push.preview')}
                    value={n.prefs.preview}
                    onValueChange={(v) => void n.togglePhonePref('preview', v)}
                  />
                </FormSection>
                <FormSection>
                  <FormActionRow
                    label={n.testing ? t('push.testSending') : t('push.test')}
                    icon="send"
                    onPress={() => void n.test()}
                  />
                </FormSection>
              </>
            ) : null}
          </>
        ) : n.pushKnown ? (
          <FormSection title={t('push.thisPhone')}>
            <FormValueRow label={t('push.unavailableDisabled')} value="" />
          </FormSection>
        ) : (
          <FormSection>
            <FormLoading />
          </FormSection>
        )}
      </NativeForm>
    </>
  );
}
