import React from 'react';
import { useNavigation } from 'expo-router';
import { DrawerActions } from 'expo-router/react-navigation';
import { useWindowDimensions } from 'react-native';
import { useWideShell } from '../shell/wide-shell.web';
import { useT } from '../lib/i18n';
import { ScreenActions } from './screen-actions.web';
export function usePersistentSidebar() {
  return useWindowDimensions().width >= 760;
}
export function SidebarToolbar() {
  const { width } = useWindowDimensions();
  const shell = useWideShell();
  const navigation = useNavigation();
  const t = useT();
  return (
    <ScreenActions
      placement="left"
      actions={
        width >= 1100
          ? []
          : [
              {
                id: 'sidebar',
                icon: 'menu',
                label: t('nav.sidebar'),
                onPress: () =>
                  width >= 760 ? shell.toggleSecondary() : navigation.dispatch(DrawerActions.openDrawer()),
              },
            ]
      }
    />
  );
}
