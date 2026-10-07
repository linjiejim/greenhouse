/**
 * `/bots/profile?botId=&from=` — a Bot's profile as a sheet: who it is, what
 * it is for, how it works, what it alone remembers (each memory can be
 * forgotten), and archive (spec docs/specs/20261008-mobile-bots.md §2.5.7).
 * `from` is the conversation it was opened from — its DM hides 发消息. The
 * body is the shared `BotProfileView` (also the Settings → My Bots page);
 * the bar: ✕ here, 编辑 from the view.
 */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { BotProfileView } from '../../src/bots/manage/bot-profile-view';
import { BotsRouteGate } from '../../src/bots/route-gate';
import { SheetClose } from '../../src/ui/sheet-chrome';

/** Bot identity only (an internal account; the conversations may be off) — closed → home: src/bots/route-gate.tsx. */
export default function BotProfileRoute() {
  return (
    <BotsRouteGate kind="identity">
      <BotProfileSheet />
    </BotsRouteGate>
  );
}

function BotProfileSheet() {
  const { botId, from } = useLocalSearchParams<{ botId?: string; from?: string }>();
  return (
    <>
      <SheetClose />
      <BotProfileView botId={botId ?? ''} from={from || undefined} presentation="sheet" />
    </>
  );
}
