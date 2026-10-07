/**
 * `/bots/info?c=` — a conversation's info: digest, group settings, members
 * (SwiftUI form, changes apply at once; spec §2.5.7). Android: ./info.android.tsx.
 *
 * P0 STUB (spec docs/specs/20261008-mobile-bots.md §8 — package E implements
 * it): the sheet's ✕ over a loading placeholder, so the route resolves.
 */

import React from 'react';
import { ScrollView } from 'react-native';
import { Stack } from 'expo-router';
import { LoadingState } from '../../src/ui/empty';
import { SheetClose } from '../../src/ui/sheet-chrome';

export default function ConversationInfoSheet() {
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
