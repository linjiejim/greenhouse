/**
 * `/bots/profile?botId=&from=&tab=` — a Bot's profile as a sheet: who it is,
 * then its tabs — overview (instructions first), memory, notes, schedules,
 * separate chats (src/bots/manage/bot-profile-view.tsx). `from` is the
 * conversation it was opened from — its DM hides 发消息; `tab` the one shown
 * first. The body is the shared `BotProfileView` (also the Settings → My Bots
 * page); the bar: ✕ here, ✎ 新对话 and 编辑 from the view.
 */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { BotProfileView } from '../../src/bots/manage/bot-profile-view';
import { PROFILE_TABS } from '../../src/bots/manage/profile-tabs';
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
  const { botId, from, tab } = useLocalSearchParams<{ botId?: string; from?: string; tab?: string }>();
  return (
    <>
      <SheetClose />
      <BotProfileView
        botId={botId ?? ''}
        from={from || undefined}
        presentation="sheet"
        tab={PROFILE_TABS.find((value) => value === tab)}
      />
    </>
  );
}
