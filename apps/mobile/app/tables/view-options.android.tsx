/**
 * `/tables/view-options` on Android (iOS: ./view-options.tsx).
 *
 * Tables and Apps are iOS-only in v1 (spec docs/specs/20261011-mobile-tables-apps.md
 * D3: Android hides the entries); this route renders SwiftUI, which crashes on
 * Android, so a stray link here just goes back home.
 */

import { useEffect } from 'react';
import { useRouter } from 'expo-router';

export default function TablesViewOptionsAndroid() {
  const router = useRouter();
  useEffect(() => {
    router.dismissTo('/');
  }, [router]);
  return null;
}
