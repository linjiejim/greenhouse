import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import { SidebarToolbar } from '../ui/sidebar';
import { Controls } from '../ui/screen-actions.web';
import { useT } from '../lib/i18n';
export function HomeHeader({ unread }: { unread: number }) {
  const t = useT();
  const router = useRouter();
  const { width } = useWindowDimensions();
  return (
    <>
      <SidebarToolbar />
      <Stack.Screen
        options={{
          title: '',
          headerBackVisible: false,
          headerTransparent: false,
          headerRight: () => (
            <Controls
              actions={
                width >= 760
                  ? [
                      {
                        id: 'agents',
                        icon: 'sparkle',
                        label: t('client.agents'),
                        onPress: () => router.push('/me/agents'),
                      },
                    ]
                  : [
                      {
                        id: 'search',
                        icon: 'search',
                        label: t('common.search'),
                        onPress: () => router.push('/search'),
                      },
                      {
                        id: 'bell',
                        icon: 'bell',
                        label: unread > 0 ? t('home.notificationsUnread', { n: unread }) : t('notifications.title'),
                        onPress: () => router.push('/notifications'),
                      },
                    ]
              }
            />
          ),
        }}
      />
    </>
  );
}
