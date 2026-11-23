/**
 * After an update, once (jim-uiux 1.7.0 patterns/updates): the first launch on a newer version says
 * 「已更新到 4.5.0 · 查看更新内容」 (info with an action, 8 s); the action opens What's new with
 * every release since the version this device last opened (app/sheets/whats-new.tsx). A first
 * install and a version without notes say nothing, and the notes never open by themselves.
 * Android's system toast takes no action (one there would be a dialog), so it only names the
 * version; the notes are in Settings › About there too.
 *
 * The root layouts call it with `ready` once the app is on screen with a member signed in. The
 * version is the app's own (Constants, as Settings shows it); the last one opened is a pref on
 * this device (./notes.ts `SEEN_PREF`).
 */
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { loadPref, savePref } from '../api/token-storage';
import { t } from '../lib/i18n';
import { notify } from '../ui/notify';
import { bundledReleases } from './bundled';
import { launchNotes, SEEN_PREF } from './notes';

export function useUpdateNotice(ready: boolean): void {
  const started = useRef(false);
  useEffect(() => {
    const version = Constants.expoConfig?.version;
    if (!ready || !version || started.current) return;
    started.current = true;
    void (async () => {
      const seen = await loadPref(SEEN_PREF);
      const launch = launchNotes(seen, version, bundledReleases);
      // remembered before it is said: a reload or a second window never says it again
      if (launch.remember) await savePref(SEEN_PREF, version);
      if (!seen || !launch.announce.length) return;
      const open = () => router.push({ pathname: '/sheets/whats-new', params: { since: seen } });
      notify.info(
        t('whatsNew.updatedTo', { version }),
        Platform.OS === 'android' ? undefined : { action: { label: t('whatsNew.see'), onPress: open } },
      );
    })();
  }, [ready]);
}
