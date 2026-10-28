/**
 * Stations sheet — opened from the login screen's server row (form sheet with
 * a native nav bar; presentation declared in app/_layout.tsx). The body is the
 * shared StationsForm; switching / adding a station dismisses the sheet and
 * the root layout reroutes once auth re-bootstraps. Changes apply at once, so
 * the toolbar only has ✕ (`SheetClose`).
 */

import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { StationsForm } from '../../src/stations/stations-form';
import { useT } from '../../src/lib/i18n';
import { SheetClose } from '../../src/ui/sheet-chrome';

export default function StationsSheet() {
  const t = useT();
  const router = useRouter();
  const close = () => router.back();
  return (
    <>
      <Stack.Screen options={{ title: t('station.title') }} />
      <SheetClose />
      <StationsForm onDone={close} onLeave={close} />
    </>
  );
}
