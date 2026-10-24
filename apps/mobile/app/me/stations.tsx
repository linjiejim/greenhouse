/**
 * Settings → 工作站 (pushed page in the settings stack). Same body as the
 * login sheet (StationsForm). Tapping the current station pops back; any change
 * of the active station closes the whole Settings modal first, because the
 * app reroutes (home or /login) once auth re-bootstraps for the new station.
 */

import React, { useCallback } from 'react';
import { Stack, useNavigation, useRouter } from 'expo-router';
import { StationsForm } from '../../src/stations/stations-form';
import { useT } from '../../src/lib/i18n';

export default function SettingsStations() {
  const t = useT();
  const router = useRouter();
  const navigation = useNavigation();
  // the parent of this stack is the root stack's `settings` modal route
  const closeSettings = useCallback(() => navigation.getParent()?.goBack(), [navigation]);
  return (
    <>
      <Stack.Screen options={{ title: t('station.title') }} />
      <StationsForm onDone={() => router.back()} onLeave={closeSettings} />
    </>
  );
}
