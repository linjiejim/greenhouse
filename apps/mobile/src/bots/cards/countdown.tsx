/**
 * "Expires in 42s" under a pending card — only in its last minute, read from
 * the server's `expires_at` and clamped (./decision.ts `countdown`, D11). At
 * zero it says "Expiring now" and waits for the server to flip the card to
 * expired: the device clock never decides it is over. Re-renders only itself,
 * once a second inside the window and not at all before it.
 */

import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import type { BotRequestView } from '../../shared/bots';
import { useT } from '../../lib/i18n';
import { typo, useTheme } from '../../theme';
import { countdown, countdownNextChange } from './decision';

export function Countdown({ request }: { request: Pick<BotRequestView, 'status' | 'expires_at' | 'created_at'> }) {
  const t = useT();
  const { colors: c } = useTheme();
  const [now, setNow] = useState(() => Date.now());
  const { status, expires_at, created_at } = request;

  useEffect(() => {
    const wait = countdownNextChange({ status, expires_at, created_at }, Date.now());
    if (wait === null) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [status, expires_at, created_at, now]);

  const { show, seconds } = countdown({ status, expires_at, created_at }, now);
  if (!show) return null;
  return (
    <Text style={{ ...typo.caption1, color: c.orange, alignSelf: 'flex-end' }}>
      {seconds > 0 ? t('bots.card.expiresIn', { s: seconds }) : t('bots.card.expiringNow')}
    </Text>
  );
}
