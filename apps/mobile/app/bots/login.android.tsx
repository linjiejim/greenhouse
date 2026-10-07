/**
 * `/bots/login` on Android (iOS: ./login.tsx).
 *
 * Android has no Bots entry in v1 (spec docs/specs/20261008-mobile-bots.md
 * §2.9): a stray link here just goes back home, as it was — no params, so
 * `dismissTo` keeps the surface that was showing.
 */

import { useEffect } from 'react';
import { useRouter } from 'expo-router';

export default function BotLoginAndroid() {
  const router = useRouter();
  useEffect(() => {
    router.dismissTo('/');
  }, [router]);
  return null;
}
