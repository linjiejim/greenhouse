/**
 * Settings → 通知 (`/settings/notifications`, a large-title page in the settings stack;
 * spec docs/specs/20261010-mobile-push.md §2.3). A SwiftUI Form for this phone on the
 * active station:
 *
 *  - 推送通知 — this station's switch (off unregisters the phone there; each station is
 *    set separately). With iOS notifications off for the app, a row says so and opens
 *    the system settings; never asked yet, switching on brings up the system prompt;
 *  - 这些时候提醒我 — needs you / a task finishes / replies (the device's prefs);
 *  - 隐私 — show previews (off by default: only who + what kind of thing);
 *  - 发一条测试通知 — the server sends this phone one push now (checks exp.host too).
 *
 * The page reads the station once on entry and whenever the app comes back to the
 * front (iOS settings may have changed). The Settings root shows the row only for a
 * station that pushes; reached anyway (a deep link), the page says why it can't.
 */

import React, { useEffect, useState } from 'react';
import { AppState, Linking } from 'react-native';
import { Stack } from 'expo-router';
import { Button, ProgressView, Section, Text, Toggle } from '@expo/ui/swift-ui';
import { frame } from '@expo/ui/swift-ui/modifiers';
import { sendTestPush } from '../../src/api/push';
import { useT } from '../../src/lib/i18n';
import { setPushOff, setPushPrefs, syncPush, usePush } from '../../src/push/register';
import type { PushPrefs } from '../../src/shared/push';
import { useActiveStation } from '../../src/stations/use-active-station';
import { alertError } from '../../src/ui/dialogs';
import { EmptyState } from '../../src/ui/empty';
import { NativeForm } from '../../src/ui/native-form';
import { toast } from '../../src/ui/toast';

export default function SettingsNotifications() {
  const t = useT();
  const station = useActiveStation();
  const support = usePush((s) => s.support);
  const permission = usePush((s) => s.permission);
  const device = usePush((s) => s.device);
  const off = usePush((s) => s.off);
  const tokenFailed = usePush((s) => s.tokenFailed);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void syncPush();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncPush();
    });
    return () => sub.remove();
  }, []);

  if (support === 'unsupported' || support === 'disabled') {
    return (
      <>
        <Stack.Screen options={{ title: t('push.title') }} />
        <EmptyState
          icon="sleep"
          title={t('push.unavailableTitle')}
          message={t(support === 'unsupported' ? 'push.unavailableUnsupported' : 'push.unavailableDisabled')}
          style={{ flex: 1 }}
        />
      </>
    );
  }

  const systemOff = permission === 'denied';
  const on = !off && permission === 'granted' && !!device;
  const prefs = device?.prefs ?? null;

  const toggleStation = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    const ok = await setPushOff(!next);
    setBusy(false);
    if (!ok) alertError(t('push.saveFailed'));
    else if (next && usePush.getState().permission === 'denied') {
      alertError(t('push.deniedTitle'), t('push.deniedMessage'));
    }
  };

  const togglePref = async (key: keyof PushPrefs, value: boolean) => {
    if (!(await setPushPrefs({ [key]: value }))) alertError(t('push.saveFailed'));
  };

  const test = async () => {
    if (!device || testing) return;
    setTesting(true);
    const result = await sendTestPush(device.id);
    setTesting(false);
    if (result.ok) {
      toast(t('push.testSent'), 'check');
      return;
    }
    if (result.code === 'too_soon') alertError(t('push.testFailed'), t('push.testTooSoon'));
    else if (result.code === 'device_not_registered' || result.code === 'device_disabled') {
      alertError(t('push.testFailed'), t('push.testUnregistered'));
      void syncPush();
    } else alertError(t('push.testFailed'), undefined, result.error);
  };

  return (
    <>
      <Stack.Screen options={{ title: t('push.title') }} />
      {/* one Form instance from the first frame (apps/mobile/AGENTS.md: late Hosts lose the nav-bar inset) */}
      <NativeForm>
        {support === 'unknown' ? (
          <Section>
            <ProgressView />
          </Section>
        ) : (
          <>
            <Section
              footer={
                <Text>
                  {systemOff
                    ? t('push.systemOff')
                    : tokenFailed && !off && permission === 'granted'
                      ? t('push.tokenFailed')
                      : t('push.stationFooter', { station: station?.name ?? '' })}
                </Text>
              }
            >
              <Toggle label={t('push.enable')} isOn={on} onIsOnChange={(next) => void toggleStation(next)} />
              {systemOff ? (
                <Button onPress={() => void Linking.openSettings()}>
                  <Text modifiers={[frame({ maxWidth: 9999, alignment: 'leading' })]}>
                    {t('push.openSystemSettings')}
                  </Text>
                </Button>
              ) : null}
            </Section>

            {on && prefs ? (
              <>
                <Section title={t('push.kinds')} footer={<Text>{t('push.kindsFooter')}</Text>}>
                  <Toggle
                    label={t('push.needsYou')}
                    isOn={prefs.needs_you}
                    onIsOnChange={(v) => void togglePref('needs_you', v)}
                  />
                  <Toggle label={t('push.done')} isOn={prefs.done} onIsOnChange={(v) => void togglePref('done', v)} />
                  <Toggle
                    label={t('push.replies')}
                    isOn={prefs.replies}
                    onIsOnChange={(v) => void togglePref('replies', v)}
                  />
                </Section>
                <Section title={t('push.privacy')} footer={<Text>{t('push.previewFooter')}</Text>}>
                  <Toggle
                    label={t('push.preview')}
                    isOn={prefs.preview}
                    onIsOnChange={(v) => void togglePref('preview', v)}
                  />
                </Section>
                <Section>
                  <Button onPress={() => void test()}>
                    <Text modifiers={[frame({ maxWidth: 9999, alignment: 'leading' })]}>{t('push.test')}</Text>
                  </Button>
                </Section>
              </>
            ) : null}
          </>
        )}
      </NativeForm>
    </>
  );
}
