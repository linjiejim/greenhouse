/**
 * HomeDrawerContent — contents of the Home left drawer: account header + a
 * navigation directory (知识库 / 项目 / 历史会话) + a fixed footer (设置 + 工作站
 * switcher) + version, rendered by the native Drawer navigator
 * (app/(drawer)/_layout.tsx). The 工作站 row shows the active station and opens
 * the StationSheet to switch; sign-out lives at the bottom of the Settings
 * screen. History lives behind the Home top-bar icon and the standalone
 * /history page — the drawer only navigates. Always closes the drawer before
 * pushing so the incoming screen animates over a settling panel.
 */

import React, { useCallback, useState } from 'react';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import type { DrawerContentComponentProps } from 'expo-router/drawer';
import { useAuth } from '../store/auth';
import { StationSheet, useActiveStation } from '../stations/station-sheet';
import { useT } from '../lib/i18n';
import { DrawerRow, DrawerScaffold } from '../ui';

export function HomeDrawerContent({ navigation }: DrawerContentComponentProps) {
  const t = useT();
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const station = useActiveStation();
  const [stationOpen, setStationOpen] = useState(false);
  const nickname = user?.nickname ?? t('home.fallbackName');
  const version = Constants.expoConfig?.version ?? '1.0.0';

  const close = useCallback(() => navigation.closeDrawer(), [navigation]);

  // Close the drawer, then push — the panel slides out under the incoming screen
  // (same pattern as 设置, so the two overlays don't fight).
  const navigate = useCallback(
    (path: '/knowledge' | '/projects' | '/history' | '/settings') => {
      close();
      setTimeout(() => router.push(path), 120);
    },
    [close, router],
  );

  return (
    <>
      <DrawerScaffold
        name={nickname}
        email={user?.email}
        version={version}
        footer={
          <>
            <DrawerRow icon="gear" label={t('drawer.settings')} onPress={() => navigate('/settings')} />
            <DrawerRow
              icon="server"
              label={t('station.title')}
              value={station?.name}
              onPress={() => setStationOpen(true)}
            />
          </>
        }
      >
        <DrawerRow icon="book" label={t('drawer.knowledge')} onPress={() => navigate('/knowledge')} />
        <DrawerRow icon="folder" label={t('drawer.projects')} onPress={() => navigate('/projects')} />
        <DrawerRow icon="clock" label={t('drawer.history')} onPress={() => navigate('/history')} />
      </DrawerScaffold>

      <StationSheet visible={stationOpen} onClose={() => setStationOpen(false)} />
    </>

  );
}
