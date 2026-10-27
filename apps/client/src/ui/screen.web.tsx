import { CommonActions, useNavigation, useNavigationState } from 'expo-router/react-navigation';
import { inspectorCount, promotedInspectorRoutes } from '../shell/inspector-model';
import React from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type { IconName } from './core';
import { Controls, ScreenActions } from './screen-actions.web';
import { useT } from '../lib/i18n';
import { typo, useTheme } from '../theme';
import { WIDE_MIN } from '../shell/wide-model';
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
  const { width } = useWindowDimensions();
  const state = useNavigationState((state) => state);
  const navigation = useNavigation();
  const depth = inspectorCount(state.routes);
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
          <button
            data-testid="inspector-back"
            onClick={() => router.back()}
            style={{
              display: 'flex',
              alignItems: 'center',
              border: 0,
              background: 'transparent',
              color: c.accentText,
              marginRight: 8,
            }}
          >
            ‹ {t('client.back')}
          </button>
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
              onPress: () => {
                const routes = promotedInspectorRoutes(state.routes.slice(0, state.index + 1));
                navigation.dispatch(CommonActions.reset({ ...state, index: routes.length - 1, routes }));
              },
            },
            {
              id: 'close',
              icon: 'x',
              label: t('common.close'),
              onPress: () => {
                if (router.canDismiss()) {
                  if (width >= WIDE_MIN && depth) router.dismiss(depth);
                  else router.dismiss();
                } else router.replace('/');
              },
            },
          ]}
        />
      </View>
    </>
  );
}
