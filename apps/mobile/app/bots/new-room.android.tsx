/**
 * `/bots/new-room` on Android (iOS: ./new-room.tsx).
 *
 * Android has no Agents entry in v1 (spec docs/specs/20261008-mobile-bots.md §2.9) — no way in
 * either (the drawer's People section and the ✎ menu are iOS-only): a stray link here just goes
 * back home, as it was — no params, so `dismissTo` keeps the surface that was showing. (The iOS
 * view renders SwiftUI, which crashes on Android.)
 */

import { useEffect } from 'react';
import { useRouter } from 'expo-router';

export default function NewRoomAndroid() {
  const router = useRouter();
  useEffect(() => {
    router.dismissTo('/');
  }, [router]);
  return null;
}
