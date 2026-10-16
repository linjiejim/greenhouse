/**
 * Settings → 通知 (`/settings/notifications`, a large-title page in the settings stack; SET-02,
 * CHN-04). A SwiftUI Form (the behaviour is src/settings/use-notification-settings.ts):
 *
 *  - one section per kind of notification (需要你, 回复与提及, 运行与定时, 其他) with a switch
 *    for each channel this member can use (the in-app center always has everything); then
 *    内容摘要 (previews, off by default);
 *  - 这台手机: pushes on this station (off unregisters the phone here; each station is set
 *    separately; with iOS notifications off a row opens the system settings), this phone's own
 *    switches (they only narrow the ones above), a test push, and Live Activities (a background
 *    run on the Lock Screen; experimental, off by default; it needs pushes here — a push is what
 *    ends it while the app is away).
 */

import React, { useEffect } from 'react';
import { AppState, Linking } from 'react-native';
import { Stack } from 'expo-router';
import { Button, Section, Text, Toggle } from '@expo/ui/swift-ui';
import { disabled, frame } from '@expo/ui/swift-ui/modifiers';
import { readTaskActivityLog } from '../../modules/widget-bridge';
import { useT } from '../../src/lib/i18n';
import { readLiveActivitySystem, setLiveActivityOn, useLiveActivity } from '../../src/live-activity/controller';
import { tallyBackgroundEnds } from '../../src/live-activity/model';
import {
  CATEGORY_LABEL,
  CHANNEL_LABEL,
  type Category,
  useNotificationSettings,
} from '../../src/settings/use-notification-settings';
import { NOTIFICATION_CATEGORIES } from '../../src/shared/contract';
import { alertError } from '../../src/ui/dialogs';
import { NativeForm, FormLoading } from '../../src/ui/native-form';

const FILL = frame({ maxWidth: 9999, alignment: 'leading' });

export default function SettingsNotifications() {
  const t = useT();
  const n = useNotificationSettings();
  const laSupported = useLiveActivity((s) => s.supported);
  const laOn = useLiveActivity((s) => s.on);
  const laSystem = useLiveActivity((s) => s.systemEnabled);

  useEffect(() => {
    readLiveActivitySystem();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') readLiveActivitySystem();
    });
    return () => sub.remove();
  }, []);

  const toggleLiveActivity = async (next: boolean) => {
    if (!(await setLiveActivityOn(next))) alertError(t('push.saveFailed'));
  };
  const laLog = laOn ? tallyBackgroundEnds(readTaskActivityLog()) : null;
  const laFooter = !n.phoneOn
    ? t('push.liveActivityNeedsPush')
    : !laSystem
      ? t('push.liveActivitySystemOff')
      : laLog && laLog.total > 0
        ? `${t('push.liveActivityFooter')}\n${t('push.liveActivityLog', { total: laLog.total, ended: laLog.ended })}`
        : t('push.liveActivityFooter');

  const channels = n.settings?.channels ?? [];
  return (
    <>
      <Stack.Screen options={{ title: t('settings.notifications') }} />
      {/* one Form instance from the first frame (apps/mobile/AGENTS.md: late Hosts lose the nav-bar inset) */}
      <NativeForm>
        {!n.settings ? (
          <Section>
            {n.failed ? (
              <Button onPress={() => void n.reload()}>
                <Text modifiers={[FILL]}>{t('common.retry')}</Text>
              </Button>
            ) : (
              <FormLoading />
            )}
          </Section>
        ) : (
          <>
            {NOTIFICATION_CATEGORIES.map((category: Category) => (
              <Section
                key={category}
                title={t(CATEGORY_LABEL[category])}
                footer={category === 'needs_you' ? <Text>{t('notifySettings.inAppAlways')}</Text> : undefined}
              >
                {channels.length ? (
                  channels.map((channel) => (
                    <Toggle
                      key={channel}
                      label={t(CHANNEL_LABEL[channel])}
                      isOn={!!n.settings!.categories[category][channel]}
                      onIsOnChange={(on) => void n.setChannel(category, channel, on)}
                    />
                  ))
                ) : (
                  <Text>{t('notifySettings.inAppOnly')}</Text>
                )}
              </Section>
            ))}
            <Section footer={<Text>{t('notifySettings.previewsFooter')}</Text>}>
              <Toggle
                label={t('notifySettings.previews')}
                isOn={n.settings.previews}
                onIsOnChange={(on) => void n.setPreviews(on)}
              />
            </Section>
          </>
        )}

        {/* ── this phone ── */}
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
                    label={t('push.replies')}
                    isOn={n.prefs.replies}
                    onIsOnChange={(v) => void n.togglePhonePref('replies', v)}
                  />
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
            {laSupported ? (
              <Section title={t('push.liveActivity')} footer={<Text>{laFooter}</Text>}>
                <Toggle
                  isOn={n.phoneOn && laOn}
                  onIsOnChange={(next) => void toggleLiveActivity(next)}
                  modifiers={n.phoneOn ? undefined : [disabled(true)]}
                >
                  <Text>{t('push.liveActivityRuns')}</Text>
                  <Text>{t('push.liveActivityExperimental')}</Text>
                </Toggle>
                {n.phoneOn && laOn && !laSystem ? (
                  <Button onPress={() => void Linking.openSettings()}>
                    <Text modifiers={[FILL]}>{t('push.openSystemSettings')}</Text>
                  </Button>
                ) : null}
              </Section>
            ) : null}
          </>
        ) : n.pushKnown ? (
          <Section title={t('push.thisPhone')}>
            <Text>{t('push.unavailableDisabled')}</Text>
          </Section>
        ) : null}
      </NativeForm>
    </>
  );
}
