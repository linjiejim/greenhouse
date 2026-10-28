/**
 * Keeps the share extension's session (./payload.ts) in the App Group keychain in step with the
 * app: written when someone is signed in on the active station (and on every token refresh,
 * so the extension's token stays fresh, and on a language change), removed on sign-out or when the active station has
 * nobody signed in. Imported once by the root layout.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { getAccessToken, onTokensChanged } from '../api/token-storage';
import { useAuth } from '../store/auth';
import { usePrefs } from '../store/prefs';
import { getActiveStation, useStations } from '../store/stations';
import { SHARE_ACCESS_GROUP, SHARE_KEYCHAIN_SERVICE, SHARE_SESSION_KEY, sharePayload } from './payload';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: SHARE_KEYCHAIN_SERVICE,
  accessGroup: SHARE_ACCESS_GROUP,
  // the extension runs while the phone is unlocked, possibly right after a reboot
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

let last = '';
function publish(): void {
  if (Platform.OS !== 'ios') return;
  const payload = sharePayload({
    station: getActiveStation(),
    accessToken: getAccessToken(),
    memberName: useAuth.getState().user?.nickname ?? null,
    lang: usePrefs.getState().lang,
  });
  const next = payload ? JSON.stringify(payload) : '';
  if (next === last) return;
  last = next;
  const write = next
    ? SecureStore.setItemAsync(SHARE_SESSION_KEY, next, OPTIONS)
    : SecureStore.deleteItemAsync(SHARE_SESSION_KEY, OPTIONS);
  void write.catch(() => {
    last = ''; // try again on the next change
  });
}

onTokensChanged(publish);
useAuth.subscribe(publish);
useStations.subscribe(publish);
usePrefs.subscribe(publish);
