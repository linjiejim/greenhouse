/**
 * `/settings/notifications` on Android (iOS: ./notifications.tsx).
 *
 * Pushes are iOS-only in v1 (Bots, and the pushes they send, are hidden on Android —
 * spec docs/specs/20261010-mobile-push.md "不做"): the Settings root shows no
 * Notifications row there, and a stray link just goes back.
 */

import { useEffect } from 'react';
import { useRouter } from 'expo-router';

export default function SettingsNotificationsAndroid() {
  const router = useRouter();
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.dismissTo('/');
  }, [router]);
  return null;
}
