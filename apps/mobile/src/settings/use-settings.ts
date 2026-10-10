/**
 * Everything the Settings root shows and changes, shared by both platforms'
 * views (app/settings/index.tsx — SwiftUI, index.android.tsx — Material):
 * account, preferences (theme / language), the station, tag count, how many
 * connectors the account can use (null: none / not for this account), usage
 * limits, version + which JS bundle is running, and sign-out (which first
 * unregisters this phone's pushes on the station). There is no
 * default agent to pick any more (2026-10): a new chat starts with Sprouty,
 * a chat with one Bot from that Bot's profile.
 */

import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useNavigation } from 'expo-router';
import { AFTER_DISMISS_MS, useAuth } from '../store/auth';
import { usePrefs } from '../store/prefs';
import { useTags } from '../store/tags';
import { useActiveStation } from '../stations/use-active-station';
import type { UserRole } from '../shared/greenhouse-types';
import { listConnectors } from '../api/connectors';
import { useT, type TranslationKey } from '../lib/i18n';
import { confirmAction } from '../ui/dialogs';
import { unregisterActive } from '../push/register';

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

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  // 连接器: only for an account with external tools (an internal member granted `mcp_call`)
  const [connectors, setConnectors] = useState<number | null>(null);
  const internal = !!user && user.role !== 'external';
  useEffect(() => {
    if (!internal) return undefined;
    let alive = true;
    void listConnectors().then((result) => {
      if (alive) setConnectors(result?.enabled && result.connectors.length ? result.connectors.length : null);
    });
    return () => {
      alive = false;
    };
  }, [internal]);

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
    // stop this station's pushes to this phone while the session still works (best effort)
    const unregistered = unregisterActive();
    navigation.getParent()?.goBack();
    setTimeout(() => void unregistered.finally(logout), AFTER_DISMISS_MS);
  };

  return {
    user,
    nickname,
    station,
    prefs,
    tagCount,
    tagsLoaded,
    connectors,
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
