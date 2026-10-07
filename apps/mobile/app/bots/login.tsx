/**
 * `/bots/login?id=&c=` — the secure sign-in sheet for a login / OTP card:
 * SwiftUI form, values never stored (spec §2.5.5). Android: ./login.android.tsx.
 *
 * P0 STUB (spec docs/specs/20261008-mobile-bots.md §8 — package C implements
 * it): the sheet's ✕ over a loading placeholder, so the route resolves.
 */

import React from 'react';
import { ScrollView } from 'react-native';
import { Stack } from 'expo-router';
import { LoadingState } from '../../src/ui/empty';
import { SheetClose } from '../../src/ui/sheet-chrome';

export default function BotLoginSheet() {
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
