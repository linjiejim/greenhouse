/**
 * Settings → 通知 (SET-02, CHN-04), shared by both platforms' pages
 * (app/settings/notifications.tsx — SwiftUI, notifications.android.tsx — Material):
 *
 *  - what reaches the member, per category (需要你, 回复与提及, 运行与定时, 其他) and channel
 *    (only the channels this member can use now: email, push …; the in-app center always has
 *    everything), and previews (off: messages say who and what kind of thing, never its subject)
 *    — `/api/me/notification-settings`, saved switch by switch;
 *  - this phone on the active station (./../push/register.ts): pushes on or off here, its own
 *    switches (they only narrow the ones above), a test push, Live Activities.
 */

import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { notificationSettings, saveNotificationSettings, sendTestPush } from '../api/me';
import { useT } from '../lib/i18n';
import { setPushOff, setPushPrefs, syncPush, usePush } from '../push/register';
import type { NotificationSettings, PushPrefs } from '../shared/contract';
import { NOTIFICATION_CATEGORIES } from '../shared/contract';
import { useActiveStation } from '../stations/use-active-station';
import { alertError } from '../ui/dialogs';
import { toast } from '../ui/toast';

export type Category = (typeof NOTIFICATION_CATEGORIES)[number];
export type Channel = NotificationSettings['channels'][number];

export const CATEGORY_LABEL = {
  needs_you: 'notifySettings.needsYou',
  replies: 'notifySettings.replies',
  runs: 'notifySettings.runs',
  other: 'notifySettings.other',
} as const;

export const CHANNEL_LABEL = {
  email: 'notifySettings.email',
  feishu: 'notifySettings.feishu',
  wecom: 'notifySettings.wecom',
  push: 'notifySettings.push',
} as const;

export function useNotificationSettings() {
  const t = useT();
  const station = useActiveStation();
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const support = usePush((s) => s.support);
  const permission = usePush((s) => s.permission);
  const device = usePush((s) => s.device);
  const off = usePush((s) => s.off);
  const tokenFailed = usePush((s) => s.tokenFailed);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    const result = await notificationSettings();
    if (result.ok) {
      setSettings(result.data);
      setFailed(false);
    } else setFailed(true);
  }, []);

  useEffect(() => {
    void load();
    void syncPush();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncPush();
    });
    return () => sub.remove();
  }, [load]);

  const setChannel = async (category: Category, channel: Channel, on: boolean) => {
    if (!settings) return;
    const before = settings;
    const categories = { ...settings.categories, [category]: { ...settings.categories[category], [channel]: on } };
    setSettings({ ...settings, categories });
    const result = await saveNotificationSettings({ categories: { [category]: categories[category] } });
    if (result.ok) setSettings(result.data);
    else {
      setSettings(before);
      alertError(t('settings.saveFailed'), result.message || undefined);
    }
  };

  const setPreviews = async (on: boolean) => {
    if (!settings) return;
    const before = settings;
    setSettings({ ...settings, previews: on });
    const result = await saveNotificationSettings({ previews: on });
    if (result.ok) setSettings(result.data);
    else {
      setSettings(before);
      alertError(t('settings.saveFailed'), result.message || undefined);
    }
  };

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
    // the channel list follows: a phone with the app is what makes push a channel
    void load();
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
    if (result.code === 'too_soon') alertError(t('push.testFailed'), t('push.testTooSoon'));
    else if (result.code === 'device_not_registered' || result.code === 'device_disabled') {
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
    settings,
    failed,
    reload: load,
    setChannel,
    setPreviews,
    /** This deployment sends pushes at all. */
    pushes: support === 'enabled',
    pushKnown: support !== 'unknown',
    systemOff,
    phoneOn,
    prefs: device?.prefs ?? null,
    togglePhone,
    togglePhonePref,
    test,
    testing,
    footer,
  };
}
