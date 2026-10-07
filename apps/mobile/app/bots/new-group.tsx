/**
 * `/bots/new-group` — pick 2–6 Bots for a group; the first pick leads
 * (spec §2.5.7).
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

export default function NewGroupSheet() {
  const t = useT();
  return (
    <>
      <Stack.Screen options={{ title: t('bots.manage.groupTitle') }} />
      <SheetClose />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ flexGrow: 1 }}>
        <LoadingState style={{ flex: 1 }} />
      </ScrollView>
    </>
  );
}
