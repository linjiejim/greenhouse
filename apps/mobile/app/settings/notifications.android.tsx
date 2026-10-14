/**
 * Settings → 通知 on Android (iOS: ./notifications.tsx; both read
 * src/settings/use-notification-settings.ts): channels per kind of notification and previews,
 * then this phone — pushes on this station, its own switches, a test push. No Live Activities
 * (an iOS feature).
 */

import React from 'react';
import { Linking } from 'react-native';
import { Stack } from 'expo-router';
import { useT } from '../../src/lib/i18n';
import {
  CATEGORY_LABEL,
  CHANNEL_LABEL,
  type Category,
  useNotificationSettings,
} from '../../src/settings/use-notification-settings';
import { NOTIFICATION_CATEGORIES } from '../../src/shared/contract';
import {
  FormActionRow,
  FormSection,
  FormSwitchRow,
  FormValueRow,
  NativeForm,
} from '../../src/ui/native-form.android';

export default function SettingsNotifications() {
  const t = useT();
  const n = useNotificationSettings();
  const channels = n.settings?.channels ?? [];
  return (
    <>
      <Stack.Screen options={{ title: t('settings.notifications') }} />
      <NativeForm>
        {!n.settings ? (
          <FormSection>
            {n.failed ? (
              <FormActionRow label={t('common.retry')} icon="refresh" onPress={() => void n.reload()} />
            ) : (
              <FormValueRow label={t('common.loading')} value="" />
            )}
          </FormSection>
        ) : (
          <>
            {NOTIFICATION_CATEGORIES.map((category: Category) => (
              <FormSection
                key={category}
                title={t(CATEGORY_LABEL[category])}
                footer={category === 'needs_you' ? t('notifySettings.inAppAlways') : undefined}
              >
                {channels.length ? (
                  channels.map((channel) => (
                    <FormSwitchRow
                      key={channel}
                      label={t(CHANNEL_LABEL[channel])}
                      value={!!n.settings!.categories[category][channel]}
                      onValueChange={(on) => void n.setChannel(category, channel, on)}
                    />
                  ))
                ) : (
                  <FormValueRow label={t('notifySettings.inAppOnly')} value="" />
                )}
              </FormSection>
            ))}
            <FormSection footer={t('notifySettings.previewsFooter')}>
              <FormSwitchRow
                label={t('notifySettings.previews')}
                value={n.settings.previews}
                onValueChange={(on) => void n.setPreviews(on)}
              />
            </FormSection>
          </>
        )}

        {n.pushes ? (
          <>
            <FormSection title={t('push.thisPhone')} footer={n.footer}>
              <FormSwitchRow label={t('push.enable')} value={n.phoneOn} onValueChange={(next) => void n.togglePhone(next)} />
              {n.systemOff ? (
                <FormActionRow label={t('push.openSystemSettings')} icon="gear" onPress={() => void Linking.openSettings()} />
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
                  <FormSwitchRow label={t('push.done')} value={n.prefs.done} onValueChange={(v) => void n.togglePhonePref('done', v)} />
                  <FormSwitchRow
                    label={t('push.replies')}
                    value={n.prefs.replies}
                    onValueChange={(v) => void n.togglePhonePref('replies', v)}
                  />
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
        ) : null}
      </NativeForm>
    </>
  );
}
