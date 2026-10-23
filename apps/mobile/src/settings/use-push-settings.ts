/**
 * Settings → 通知, shared by both platforms' pages (app/settings/notifications.tsx — SwiftUI,
 * notifications.android.tsx — Material): this phone on the active station (../push/register.ts)
 * — pushes on or off here, its own switches per kind of notification and previews (off: a push
 * says only what kind of thing happened), and a test push. The in-app list always has
 * everything; Feishu, WeCom and email delivery are set on the web.
 */

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { sendTestPush } from '../api/push';
import { useT } from '../lib/i18n';
import { setPushOff, setPushPrefs, syncPush, usePush } from '../push/register';
import type { PushPrefs } from '../shared/push';
import { useActiveStation } from '../stations/use-active-station';
import { alertError } from '../ui/dialogs';
import { toast } from '../ui/toast';

export function usePushSettings() {
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

  const systemOff = permission === 'denied';
  const phoneOn = !off && permission === 'granted' && !!device;

  const togglePhone = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    const ok = await setPushOff(!next);
    setBusy(false);
    if (!ok) alertError(t('push.saveFailed'));
    else if (next && usePush.getState().permission === 'denied') {
      alertError(t('push.deniedTitle'), t('push.deniedMessage'));
    }
  };

  const togglePhonePref = async (key: keyof PushPrefs, value: boolean) => {
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
    if (result.status === 429) alertError(t('push.testFailed'), t('push.testTooSoon'));
    else if (result.status === 409) {
      alertError(t('push.testFailed'), t('push.testUnregistered'));
      void syncPush();
    } else alertError(t('push.testFailed'), result.message || undefined);
  };

  const footer = systemOff
    ? t('push.systemOff')
    : tokenFailed && !off && permission === 'granted'
      ? t('push.tokenFailed')
      : t('push.stationFooter', { station: station?.name ?? '' });

  return {
    /** This deployment sends pushes at all. */
    pushes: support === 'enabled',
    pushKnown: support !== 'unknown',
    systemOff,
    phoneOn,
    busy,
    prefs: device?.prefs ?? null,
    togglePhone,
    togglePhonePref,
    test,
    testing,
    footer,
  };
}
