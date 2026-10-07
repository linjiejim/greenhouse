/**
 * `/bots/request?id=&c=` — a card's full content (approval details, task
 * brief, instructions diff) with the same decision buttons (spec §2.5.6).
 *
 * P0 STUB (spec docs/specs/20261008-mobile-bots.md §8 — package C implements
 * it): the sheet's ✕ over a loading placeholder, so the route resolves.
 */

import React from 'react';
import { ScrollView } from 'react-native';
import { Stack } from 'expo-router';
import { LoadingState } from '../../src/ui/empty';
import { SheetClose } from '../../src/ui/sheet-chrome';

export default function RequestSheet() {
  return (
    <>
      <Stack.Screen options={{ title: '' }} />
      <SheetClose />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ flexGrow: 1 }}>
        <LoadingState style={{ flex: 1 }} />
      </ScrollView>
    </>
  );
}
