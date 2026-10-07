/**
 * `/bots/needs-you` — every card waiting on the member across conversations,
 * decided in place (spec §2.5.6). Sheet `[0.6, 1]` (app/_layout.tsx).
 *
 * P0 STUB (spec docs/specs/20261008-mobile-bots.md §8 — package C implements
 * it): the sheet's ✕ over a loading placeholder, so the route resolves.
 */

import React from 'react';
import { ScrollView } from 'react-native';
import { Stack } from 'expo-router';
import { useT } from '../../src/lib/i18n';
import { LoadingState } from '../../src/ui/empty';
import { SheetClose } from '../../src/ui/sheet-chrome';

export default function NeedsYouSheet() {
  const t = useT();
  return (
    <>
      <Stack.Screen options={{ title: t('bots.needs.title') }} />
      <SheetClose />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ flexGrow: 1 }}>
        <LoadingState style={{ flex: 1 }} />
      </ScrollView>
    </>
  );
}
