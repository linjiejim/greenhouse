/**
 * Settings → My Bots → a Bot (`/settings/bot?id=`, pushed in the settings
 * stack): the full-page Bot profile (the same `BotProfileView` as the
 * `/bots/profile` sheet; spec docs/specs/20261008-mobile-bots.md §2.5.7).
 *
 * P0 STUB (package E implements it): a loading placeholder, so the route
 * resolves.
 */

import React from 'react';
import { ScrollView } from 'react-native';
import { Stack } from 'expo-router';
import { LoadingState } from '../../src/ui/empty';

export default function SettingsBot() {
  return (
    <>
      <Stack.Screen options={{ title: '' }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ flexGrow: 1 }}>
        <LoadingState style={{ flex: 1 }} />
      </ScrollView>
    </>
  );
}
