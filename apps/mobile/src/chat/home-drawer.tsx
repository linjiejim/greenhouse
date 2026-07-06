/**
 * HomeDrawerContent — contents of the Home left drawer: account header + a
 * navigation directory (知识库 / 项目 / 历史会话) + 设置 footer + 退出登录 + version,
 * rendered by the native Drawer navigator (app/(drawer)/_layout.tsx). History
 * now lives behind the Home top-bar icon and the standalone /history page — the
 * drawer only navigates. Always closes the drawer before pushing so the incoming
 * screen animates over a settling panel.
 */

import React, { useCallback } from 'react';
import { Alert } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import type { DrawerContentComponentProps } from 'expo-router/drawer';
import { useAuth } from '../store/auth';
import { useT } from '../lib/i18n';
import { DrawerRow, DrawerScaffold } from '../ui';

export function HomeDrawerContent({ navigation }: DrawerContentComponentProps) {
  const t = useT();
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const nickname = user?.nickname ?? t('home.fallbackName');
  const version = Constants.expoConfig?.version ?? '1.0.0';

  const close = useCallback(() => navigation.closeDrawer(), [navigation]);

  // Close the drawer, then push — the panel slides out under the incoming screen
  // (same pattern as 设置, so the two overlays don't fight).
  const navigate = useCallback(
    (path: '/knowledge' | '/history' | '/settings') => {
      close();
      setTimeout(() => router.push(path), 120);
    },
    [close, router],
  );

  const onLogout = useCallback(() => {
    close();
    setTimeout(() => {
      logout();
      router.replace('/login');
    }, 140);
  }, [close, logout, router]);

  return (
    <DrawerScaffold
      name={nickname}
      email={user?.email}
      version={version}
      onLogout={onLogout}
      footer={<DrawerRow icon="gear" label={t('drawer.settings')} onPress={() => navigate('/settings')} />}
    >
      <DrawerRow icon="book" label={t('drawer.knowledge')} onPress={() => navigate('/knowledge')} />
      {/* 项目管理属需求 6，本任务只占位入口 */}
      <DrawerRow
        icon="folder"
        label={t('drawer.projects')}
        onPress={() => {
          close();
          Alert.alert(t('common.comingSoon'));
        }}
      />
      <DrawerRow icon="clock" label={t('drawer.history')} onPress={() => navigate('/history')} />
    </DrawerScaffold>
  );
}
