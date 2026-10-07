/**
 * `/bots/bot-form?botId=&template=&request=&inviteTo=` — create / edit a Bot,
 * or edit a proposed one before accepting (SwiftUI form, spec §2.5.7).
 * Android: ./bot-form.android.tsx.
 *
 * P0 STUB (spec docs/specs/20261008-mobile-bots.md §8 — package E implements
 * it): the sheet's ✕ over a loading placeholder, so the route resolves.
 */

import React from 'react';
import { ScrollView } from 'react-native';
import { Stack } from 'expo-router';
import { useT } from '../../src/lib/i18n';
import { LoadingState } from '../../src/ui/empty';
import { SheetClose } from '../../src/ui/sheet-chrome';

export default function BotFormSheet() {
  const t = useT();
  return (
    <>
      <Stack.Screen options={{ title: t('bots.manage.formNew') }} />
      <SheetClose />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ flexGrow: 1 }}>
        <LoadingState style={{ flex: 1 }} />
      </ScrollView>
    </>
  );
}
