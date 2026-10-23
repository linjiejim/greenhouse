/**
 * Everything Settings shows and changes, shared by both platforms' views (app/settings/index.tsx
 * — SwiftUI, index.android.tsx — Material): the member's account (name and email as the server
 * has them; the language is the account's, `PUT /api/auth/me/preferences`), this phone's theme,
 * the station, notifications, the version and which JS bundle runs, and sign-out (which first
 * unregisters this phone's pushes on the station and forgets the member's offline copies).
 *
 * The language applies at once and is then saved to the account; a save that fails puts it back
 * and says so.
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useNavigation } from 'expo-router';
import { saveLocale } from '../api/auth';
import { useT } from '../lib/i18n';
import { useActiveStation } from '../stations/use-active-station';
import { AFTER_DISMISS_MS, useAuth } from '../store/auth';
import { forgetOfflineCopies } from '../store/notifications';
import { usePrefs, type LangPref, type ThemePref } from '../store/prefs';
import { useStations } from '../store/stations';
import { alertError, confirmAction } from '../ui/dialogs';
import { PUSH_PLATFORM_READY, unregisterActive, usePush } from '../push/register';

export function useSettings() {
  const t = useT();
  const navigation = useNavigation();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const theme = usePrefs((s) => s.theme);
  const lang = usePrefs((s) => s.lang);
  const station = useActiveStation();

  // "1.4.0 (5)" — marketing version + build number
  const build =
    Platform.OS === 'ios'
      ? Constants.platform?.ios?.buildNumber
      : Constants.expoConfig?.android?.versionCode?.toString();
  const version = `${Constants.expoConfig?.version ?? ''}${build ? ` (${build})` : ''}`.trim();

  /** This phone's appearance (not an account setting on this server). */
  const setTheme = (next: ThemePref) => usePrefs.getState().setTheme(next);

  const setLanguage = async (next: LangPref) => {
    const before = usePrefs.getState().lang;
    if (before === next) return;
    usePrefs.getState().setLang(next);
    const result = await saveLocale(next);
    if (!result.ok) {
      usePrefs.getState().setLang(before);
      alertError(t('settings.saveFailed'), result.message || undefined);
      return;
    }
    useAuth.getState().setUser(result.data);
  };

  const signOut = async () => {
    const ok = await confirmAction({
      title: t('settings.logout'),
      message: t('settings.logoutConfirm'),
      confirmLabel: t('settings.logout'),
      destructive: true,
    });
    if (!ok) return;
    const stationId = useStations.getState().activeId;
    const memberId = useAuth.getState().user?.id;
    // stop this station's pushes to this phone while the session still works (best effort)
    const unregistered = unregisterActive();
    navigation.getParent()?.goBack();
    setTimeout(
      () =>
        void unregistered.finally(() => {
          if (stationId && memberId) forgetOfflineCopies(stationId, memberId);
          logout();
        }),
      AFTER_DISMISS_MS,
    );
  };

  return {
    user,
    station,
    theme,
    lang,
    setTheme,
    setLanguage,
    version,
    update: updateLabel(t),
    signOut,
  };
}

/** Which JS bundle is running: dev server, the binary's embedded bundle, or an OTA update. */
function updateLabel(t: ReturnType<typeof useT>): string {
  if (__DEV__) return t('settings.updateDev');
  if (!Updates.isEnabled || Updates.isEmbeddedLaunch || !Updates.updateId) return t('settings.updateEmbedded');
  const day = Updates.createdAt ? Updates.createdAt.toISOString().slice(0, 10) : '';
  return [Updates.updateId.slice(0, 8), day].filter(Boolean).join(' · ');
}

/** The 通知 row's value: this phone's pushes on the active station ('' when it does not push). */
export function usePushRow(): string {
  const t = useT();
  const support = usePush((s) => s.support);
  const permission = usePush((s) => s.permission);
  const off = usePush((s) => s.off);
  const device = usePush((s) => s.device);
  if (!PUSH_PLATFORM_READY || support !== 'enabled') return '';
  if (permission === 'denied') return t('push.rowSystemOff');
  if (off) return t('push.rowOff');
  return permission === 'granted' && device ? t('push.rowOn') : t('push.rowNotSet');
}
