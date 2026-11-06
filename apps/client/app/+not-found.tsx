/** An address this client has no screen for (an old or mistyped link) goes home, never to a blank error page. */

import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { goHome } from '../src/shell/nav';

export default function NotFound() {
  const router = useRouter();
  useEffect(() => goHome(router), [router]);
  return null;
}
