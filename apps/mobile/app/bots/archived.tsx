/**
 * `/bots/archived` — conversations that can't be replied to any more; a tap
 * opens the read-only thread (spec §2.5.7).
 *
 * P0 STUB (spec docs/specs/20261008-mobile-bots.md §8 — package D implements
 * it): the sheet's ✕ over a loading placeholder, so the route resolves.
 */

import React from 'react';
import { ScrollView } from 'react-native';
import { Stack } from 'expo-router';
import { useT } from '../../src/lib/i18n';
import { LoadingState } from '../../src/ui/empty';
import { SheetClose } from '../../src/ui/sheet-chrome';

export default function ArchivedSheet() {
  const t = useT();
  return (
    <>
      <Stack.Screen options={{ title: t('bots.nav.archivedTitle') }} />
      <SheetClose />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ flexGrow: 1 }}>
        <LoadingState style={{ flex: 1 }} />
      </ScrollView>
    </>
  );
}
