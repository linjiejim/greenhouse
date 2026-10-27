/**
 * 添加工作站 — its own form sheet over the stations list (the + in its bar). A good address
 * becomes the active station: every sheet is dismissed first and the root layout reroutes once
 * auth re-bootstraps (src/stations/use-stations-form.ts).
 */

import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { StationAddForm } from '../../src/stations/stations-form';
import { useT } from '../../src/lib/i18n';
import { SheetClose } from '../../src/ui/sheet-chrome';

export default function StationAddSheet() {
  const t = useT();
  const router = useRouter();
  return (
    <>
      <Stack.Screen options={{ title: t('station.add') }} />
      <SheetClose />
      <StationAddForm onLeave={() => router.dismissAll()} />
    </>
  );
}
