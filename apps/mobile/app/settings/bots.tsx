/**
 * Settings → My Bots (`/settings/bots`, a large-title page in the settings
 * stack): the member's Bot identities — the main assistant, the others, the
 * archived — and "New Bot" (spec docs/specs/20261008-mobile-bots.md §2.5.7).
 *
 * P0 STUB (package E implements it): the titled page over a loading
 * placeholder, so the route resolves.
 */

import React from 'react';
import { ScrollView } from 'react-native';
import { Stack } from 'expo-router';
import { useT } from '../../src/lib/i18n';
import { LoadingState } from '../../src/ui/empty';

export default function SettingsBots() {
  const t = useT();
  return (
    <>
      <Stack.Screen options={{ title: t('settings.myBots') }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ flexGrow: 1 }}>
        <LoadingState style={{ flex: 1 }} />
      </ScrollView>
    </>
  );
}
