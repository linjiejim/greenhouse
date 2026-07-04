/**
 * HomeDrawerContent — contents of the Home left drawer (account header +
 * infinite-scroll history + 设置 + 退出登录 + version), rendered by the native
 * Drawer navigator (app/(drawer)/_layout.tsx). Owns the "查看更多" full-history
 * sheet and all navigation out of the drawer; always closes the drawer before
 * pushing so the incoming screen animates over a settling panel.
 */

import React, { useCallback, useState } from 'react';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import type { DrawerContentComponentProps } from 'expo-router/drawer';
import { useAuth } from '../store/auth';
import type { Session } from '../shared/greenhouse-types';
import { useT } from '../lib/i18n';
import { DrawerRow, DrawerScaffold } from '../ui';
import { DrawerHistory } from './history-list';
import { HistorySheet, type OpenConversation } from './history-sheet';

export function HomeDrawerContent({ navigation }: DrawerContentComponentProps) {
  const t = useT();
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const nickname = user?.nickname ?? t('home.fallbackName');
  const version = Constants.expoConfig?.version ?? '1.0.0';
  const [historyOpen, setHistoryOpen] = useState(false);

  const close = useCallback(() => navigation.closeDrawer(), [navigation]);

  // Drawer → open a conversation: close the drawer, then push (the drawer slides
  // out under the incoming screen).
  const openFromDrawer = useCallback(
    (s: Session) => {
      close();
      router.push({
        pathname: '/chat/[id]',
        params: { id: s.id, title: s.title || t('chat.newConversation'), ro: s.is_owner === false ? '1' : '0' },
      });
    },
    [close, router, t],
  );

  const openConversation = useCallback(
    (c: OpenConversation) => {
      setHistoryOpen(false);
      router.push({ pathname: '/chat/[id]', params: { id: c.id, title: c.title, ro: c.readOnly ? '1' : '0' } });
    },
    [router],
  );

  // "查看更多" opens the full search sheet — wait for the drawer to clear first so
  // the two overlays don't fight.
  const openAllHistory = useCallback(() => {
    close();
    setTimeout(() => setHistoryOpen(true), 180);
  }, [close]);

  const openSettings = useCallback(() => {
    close();
    setTimeout(() => router.push('/settings'), 120);
  }, [close, router]);

  const onLogout = useCallback(() => {
    close();
    setTimeout(() => {
      logout();
      router.replace('/login');
    }, 140);
  }, [close, logout, router]);

  return (
    <>
      <DrawerScaffold
        name={nickname}
        email={user?.email}
        version={version}
        onLogout={onLogout}
        footer={<DrawerRow icon="gear" label={t('drawer.settings')} onPress={openSettings} />}
      >
        <DrawerHistory onOpen={openFromDrawer} onViewAll={openAllHistory} />
      </DrawerScaffold>

      <HistorySheet visible={historyOpen} onClose={() => setHistoryOpen(false)} onOpen={openConversation} />
    </>
  );
}
