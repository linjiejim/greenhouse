import { useNavigationState } from 'expo-router/react-navigation';
import { sheetDepth } from '../shell/object-ref';
import React from 'react';
import { Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type { IconName } from './core';
import { Controls, ScreenActions } from './screen-actions.web';
import { useT } from '../lib/i18n';
import { typo, useTheme } from '../theme';
export interface ScreenAction {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}
interface Props {
  title: string;
  actions?: readonly ScreenAction[];
  busy?: boolean;
  closeApart?: boolean;
}
export function Screen({ title, actions = [], busy }: Props) {
  return (
    <>
      <Stack.Screen options={{ title, headerShown: true }} />
      <ScreenActions
        actions={[
          ...(busy !== undefined
            ? [{ id: 'refresh', icon: 'refresh' as const, label: title, onPress: () => {}, busy }]
            : []),
          ...actions.map((a, i) => ({ ...a, id: String(i) })),
        ]}
      />
    </>
  );
}
export function SheetScreen({ title, actions = [], busy }: Props) {
  const depth = useNavigationState((state) => sheetDepth(state.routes));
  const router = useRouter();
  const t = useT();
  const { hex: c } = useTheme();
  return (
    <>
      <Stack.Screen options={{ headerShown: false, title }} />
      <View
        style={{
          height: 52,
          flexDirection: 'row',
          alignItems: 'center',
          borderBottomWidth: 1,
          borderColor: c.separator,
          paddingLeft: 16,
        }}
      >
        {depth > 1 ? (
          <Controls actions={[{ id: 'back', icon: 'chevL', label: t('client.back'), onPress: () => router.back() }]} />
        ) : null}
        <Text numberOfLines={1} accessibilityRole="header" style={{ ...typo.title3, color: c.label, flex: 1 }}>
          {title}
        </Text>
        <Controls
          actions={[
            ...(busy !== undefined
              ? [{ id: 'refresh', icon: 'refresh' as const, label: title, onPress: () => {}, busy }]
              : []),
            ...actions.map((a, i) => ({ ...a, id: String(i) })),
          ]}
        />
        <Controls
          actions={[
            {
              id: 'promote',
              icon: 'expand',
              label: t('client.promote'),
              onPress: () => router.setParams({ main: '1' }),
            },
            {
              id: 'close',
              icon: 'x',
              label: t('common.close'),
              onPress: () => {
                if (router.canDismiss()) router.dismissAll();
                else router.replace('/');
              },
            },
          ]}
        />
      </View>
    </>
  );
}
