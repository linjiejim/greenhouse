import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { SidebarToolbar } from '../ui/sidebar';
import { ScreenActions } from '../ui/screen-actions';
import { useT } from '../lib/i18n';
export function HomeHeader({ unread }: { unread: number }) {
  const t = useT();
  const router = useRouter();
  return (
    <>
      <Stack.Screen options={{ title: '', headerLargeTitleEnabled: false }} />
      <SidebarToolbar />
      <ScreenActions
        placement="right"
        actions={[
          { id: 'action-1', icon: 'search', label: t('common.search'), onPress: () => router.push('/search') },
          {
            id: 'action-2',
            icon: 'bell',
            label: unread > 0 ? t('home.notificationsUnread', { n: unread }) : t('notifications.title'),
            onPress: () => router.push('/notifications'),
            badge: unread > 99 ? '99+' : unread > 0 ? String(unread) : undefined,
          },
        ]}
      />
    </>
  );
}
