/**
 * 「我」 → 通知 (`/me/notifications`, a large-title page in the 「我」 stack). A SwiftUI
 * Form (the behaviour is src/settings/use-push-settings.ts):
 *
 *  - 这台手机: pushes on this station (off unregisters the phone here; each station is set
 *    separately; with iOS notifications off a row opens the system settings);
 *  - its switches per kind of notification (需要你, 已完成, 其他) and 显示内容预览 (off by
 *    default: a push says only what kind of thing happened);
 *  - a test push.
 */

import React from 'react';
import { Linking } from 'react-native';
import { Stack } from 'expo-router';
import { Button, Section, Text, Toggle } from '@expo/ui/swift-ui';
import { frame } from '@expo/ui/swift-ui/modifiers';
import { useT } from '../../src/lib/i18n';
import { usePushSettings } from '../../src/settings/use-push-settings';
import { FormLoading, NativeForm } from '../../src/ui/native-form';

const FILL = frame({ maxWidth: 9999, alignment: 'leading' });

export default function SettingsNotifications() {
  const t = useT();
  const n = usePushSettings();

  return (
    <>
      <Stack.Screen options={{ title: t('settings.notifications') }} />
      {/* one Form instance from the first frame (apps/mobile/AGENTS.md: late Hosts lose the nav-bar inset) */}
      <NativeForm>
        {n.pushes ? (
          <>
            <Section title={t('push.thisPhone')} footer={<Text>{n.footer}</Text>}>
              <Toggle label={t('push.enable')} isOn={n.phoneOn} onIsOnChange={(next) => void n.togglePhone(next)} />
              {n.systemOff ? (
                <Button onPress={() => void Linking.openSettings()}>
                  <Text modifiers={[FILL]}>{t('push.openSystemSettings')}</Text>
                </Button>
              ) : null}
            </Section>
            {n.phoneOn && n.prefs ? (
              <>
                <Section title={t('push.kinds')} footer={<Text>{t('push.kindsFooter')}</Text>}>
                  <Toggle
                    label={t('push.needsYou')}
                    isOn={n.prefs.needs_you}
                    onIsOnChange={(v) => void n.togglePhonePref('needs_you', v)}
                  />
                  <Toggle
                    label={t('push.done')}
                    isOn={n.prefs.done}
                    onIsOnChange={(v) => void n.togglePhonePref('done', v)}
                  />
                  <Toggle
                    label={t('push.other')}
                    isOn={n.prefs.other}
                    onIsOnChange={(v) => void n.togglePhonePref('other', v)}
                  />
                </Section>
                <Section footer={<Text>{t('push.previewFooter')}</Text>}>
                  <Toggle
                    label={t('push.preview')}
                    isOn={n.prefs.preview}
                    onIsOnChange={(v) => void n.togglePhonePref('preview', v)}
                  />
                </Section>
                <Section>
                  <Button onPress={() => void n.test()}>
                    <Text modifiers={[FILL]}>{n.testing ? t('push.testSending') : t('push.test')}</Text>
                  </Button>
                </Section>
              </>
            ) : null}
          </>
        ) : n.pushKnown ? (
          <Section title={t('push.thisPhone')}>
            <Text>{t('push.unavailableDisabled')}</Text>
          </Section>
        ) : (
          <Section>
            <FormLoading />
          </Section>
        )}
      </NativeForm>
    </>
  );
}
