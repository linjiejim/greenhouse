/**
 * Everything the Settings root shows and changes, shared by both platforms'
 * views (app/settings/index.tsx — SwiftUI, index.android.tsx — Material):
 * account, preferences (theme / language / default agent), the station, tag
 * count, usage limits, version + which JS bundle is running, and sign-out.
 */

import { useEffect, useMemo } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useNavigation } from 'expo-router';
import { AFTER_DISMISS_MS, useAuth } from '../store/auth';
import { usePrefs } from '../store/prefs';
import { useTags } from '../store/tags';
import { useActiveStation } from '../stations/use-active-station';
import { effectiveProfile, useProfiles } from '../chat/profile-menu';
import type { UserRole } from '../shared/greenhouse-types';
import { useT, type TranslationKey } from '../lib/i18n';
import { confirmAction } from '../ui/dialogs';

export const ROLE_LABEL: Record<UserRole, TranslationKey> = {
  super: 'settings.roleSuper',
  team: 'settings.roleTeam',
  external: 'settings.roleExternal',
};

export function useSettings() {
  const t = useT();
  const navigation = useNavigation();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const prefs = usePrefs();
  const station = useActiveStation();
  const tagCount = useTags((s) => s.tags.length);
  const tagsLoaded = useTags((s) => s.loaded);
  const loadTags = useTags((s) => s.load);
  // the composer's catalog cache — both pickers edit `prefs.profileId`
  const profiles = useProfiles();

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  // The stored id may be unset ('default') or stale (picked on another
  // station); show the agent the server will actually use.
  const shownProfile = useMemo(() => effectiveProfile(profiles, prefs.profileId)?.id, [profiles, prefs.profileId]);

  const nickname = user?.nickname || t('settings.fallbackName');
  // "1.3.2 (5)" — marketing version + build number
  const build =
    Platform.OS === 'ios'
      ? Constants.platform?.ios?.buildNumber
      : Constants.expoConfig?.android?.versionCode?.toString();
  const version = `${Constants.expoConfig?.version ?? ''}${build ? ` (${build})` : ''}`.trim();

  const signOut = async () => {
    const ok = await confirmAction({
      title: t('settings.logout'),
      message: t('settings.logoutConfirm'),
      confirmLabel: t('settings.logout'),
      destructive: true,
    });
    if (!ok) return;
    navigation.getParent()?.goBack();
    setTimeout(logout, AFTER_DISMISS_MS);
  };

  return {
    user,
    nickname,
    station,
    prefs,
    profiles,
    shownProfile,
    tagCount,
    tagsLoaded,
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
