/**
 * Everything Settings shows and changes, shared by both platforms' views (app/settings/index.tsx
 * — SwiftUI, index.android.tsx — Material): the member's account (SET-01: picture, name,
 * language, theme — account settings in v2, `PATCH /api/me`), the station, notifications, the
 * version and which JS bundle runs, and sign-out (which first unregisters this phone's pushes on
 * the station).
 *
 * Language and theme apply at once and are then saved to the account (instant-save settings,
 * PRD §7.9); a save that fails puts them back and says so.
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as ImagePicker from 'expo-image-picker';
import * as Updates from 'expo-updates';
import { useNavigation } from 'expo-router';
import { updateMe } from '../api/auth';
import { prepareImage, uploadFile } from '../api/files';
import { useT } from '../lib/i18n';
import type { Me } from '../shared/contract';
import { useActiveStation } from '../stations/use-active-station';
import { AFTER_DISMISS_MS, useAuth } from '../store/auth';
import { usePrefs, type LangPref, type ThemePref } from '../store/prefs';
import { alertError, confirmAction, promptText } from '../ui/dialogs';
import { toast } from '../ui/toast';
import { PUSH_PLATFORM_READY, unregisterActive, usePush } from '../push/register';


/** Saves to the account, keeping the store's member in step; undoes `undo` when it fails. */
async function saveMe(input: Parameters<typeof updateMe>[0], undo: () => void, failed: string): Promise<boolean> {
  const result = await updateMe(input);
  if (!result.ok) {
    undo();
    alertError(failed, result.message || undefined);
    return false;
  }
  useAuth.getState().setUser(result.data);
  return true;
}

export function useSettings() {
  const t = useT();
  const navigation = useNavigation();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const theme = usePrefs((s) => s.theme);
  const lang = usePrefs((s) => s.lang);
  const station = useActiveStation();

  // "1.3.2 (5)" — marketing version + build number
  const build =
    Platform.OS === 'ios'
      ? Constants.platform?.ios?.buildNumber
      : Constants.expoConfig?.android?.versionCode?.toString();
  const version = `${Constants.expoConfig?.version ?? ''}${build ? ` (${build})` : ''}`.trim();

  const setTheme = (next: ThemePref) => {
    const before = usePrefs.getState().theme;
    usePrefs.getState().setTheme(next);
    void saveMe({ theme: next }, () => usePrefs.getState().setTheme(before), t('settings.saveFailed'));
  };

  const setLanguage = (next: LangPref) => {
    const before = usePrefs.getState().lang;
    usePrefs.getState().setLang(next);
    void saveMe({ locale: next }, () => usePrefs.getState().setLang(before), t('settings.saveFailed'));
  };

  const rename = async () => {
    if (!user) return;
    const next = await promptText({
      title: t('settings.nameTitle'),
      defaultValue: user.name,
      confirmLabel: t('common.save'),
    });
    if (!next || next.trim() === user.name) return;
    await saveMe({ name: next.trim() }, () => undefined, t('settings.saveFailed'));
  };

  /** Pick a picture from the library, upload it as my avatar and use it. */
  const changeAvatar = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    const uri = await prepareImage(asset.uri, asset.width);
    const uploaded = await uploadFile(uri, {
      name: 'avatar.jpg',
      type: uri === asset.uri ? (asset.mimeType ?? 'image/jpeg') : 'image/jpeg',
      purpose: 'avatar',
    });
    if (!uploaded.ok) {
      alertError(t('settings.avatarFailed'), uploaded.message || undefined);
      return;
    }
    if (await saveMe({ avatar_file_id: uploaded.data.id }, () => undefined, t('settings.avatarFailed'))) {
      toast(t('settings.avatarSaved'), 'check');
    }
  };

  const removeAvatar = async () => {
    await saveMe({ avatar_file_id: null }, () => undefined, t('settings.saveFailed'));
  };

  const signOut = async () => {
    const ok = await confirmAction({
      title: t('settings.logout'),
      message: t('settings.logoutConfirm'),
      confirmLabel: t('settings.logout'),
      destructive: true,
    });
    if (!ok) return;
    // stop this station's pushes to this phone while the session still works (best effort)
    const unregistered = unregisterActive();
    navigation.getParent()?.goBack();
    setTimeout(() => void unregistered.finally(logout), AFTER_DISMISS_MS);
  };

  return {
    user: user as Me | null,
    station,
    theme,
    lang,
    setTheme,
    setLanguage,
    rename,
    changeAvatar,
    removeAvatar,
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
