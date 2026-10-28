import React, { useContext } from 'react';
import { Stack } from 'expo-router';
import { useIsFocused } from 'expo-router/react-navigation';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { NativeMenu } from './menu.web';
import type { MenuItem } from './menu-items';
import { Icon } from './core.web';
import { SettingsWindowContext } from './settings-frame';
import { useShortcut } from './use-shortcut.web';
import { Tooltip } from './popover.web';
import type { ScreenAction, ScreenActionsProps } from './screen-action-types';
export type { ScreenAction } from './screen-action-types';
function menuItem(a: ScreenAction): MenuItem {
  return {
    id: a.id,
    title: a.label,
    icon: a.icon,
    disabled: a.disabled,
    destructive: a.destructive,
    shortcut: a.shortcut,
    children: a.menu?.map(menuItem),
  };
}
function ActionShortcut({ action }: { action: ScreenAction }) {
  const focused = useIsFocused();
  useShortcut(action.shortcut, action.onPress, focused && !action.disabled);
  return (
    <>
      {action.menu?.map((a) => (
        <ActionShortcut key={a.id} action={a} />
      ))}
    </>
  );
}
export function Controls({ actions, maxVisible = 3 }: { actions: readonly ScreenAction[]; maxVisible?: number }) {
  const items = actions.filter((a) => !a.hidden && a.busy === undefined);
  const visible = items.slice(0, maxVisible),
    overflow = items.slice(maxVisible);
  const find = (id: string) => {
    const walk = (list: readonly ScreenAction[]): ScreenAction | undefined => {
      for (const a of list) {
        if (a.id === id) return a;
        const child = a.menu && walk(a.menu);
        if (child) return child;
      }
    };
    walk(actions)?.onPress();
  };
  const button = (a: ScreenAction) => (
    <Tooltip label={a.shortcut ? `${a.label} (${a.shortcut})` : a.label}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={a.label}
        disabled={a.disabled}
        onPress={a.menu ? undefined : a.onPress}
        style={({ pressed }) => ({
          width: 28,
          height: 28,
          justifyContent: 'center',
          alignItems: 'center',
          opacity: a.disabled ? 0.5 : pressed ? 0.6 : 1,
        })}
      >
        <Icon name={a.icon} size={18} />
      </Pressable>
    </Tooltip>
  );
  return (
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingHorizontal: 12 }}>
      {actions.some((a) => a.busy) ? <ActivityIndicator size="small" /> : null}
      {visible.map((a) => (
        <React.Fragment key={a.id}>
          {a.menu ? (
            <NativeMenu items={a.menu.map(menuItem)} onSelect={find}>
              {button(a)}
            </NativeMenu>
          ) : (
            button(a)
          )}
        </React.Fragment>
      ))}
      {overflow.length ? (
        <NativeMenu items={overflow.map(menuItem)} onSelect={find}>
          <Pressable accessibilityRole="button" accessibilityLabel="More actions" style={{ padding: 4 }}>
            <Icon name="more" size={20} />
          </Pressable>
        </NativeMenu>
      ) : null}
    </View>
  );
}
export function useScreenActions(
  actions: readonly ScreenAction[],
  { placement = 'right' }: Omit<ScreenActionsProps, 'actions'> = {},
) {
  // The settings window's close button sits at the header's right edge (app/me/_layout.web.tsx).
  const inSettingsWindow = useContext(SettingsWindowContext);
  return (
    <>
      {actions.map((a) => (
        <ActionShortcut key={a.id} action={a} />
      ))}
      <Stack.Screen
        options={
          placement === 'left'
            ? { headerLeft: () => <Controls actions={actions} /> }
            : {
                headerRight: () => (
                  <View style={inSettingsWindow ? { marginRight: 40 } : undefined}>
                    <Controls actions={actions} />
                  </View>
                ),
              }
        }
      />
    </>
  );
}
export function ScreenActions({ actions, placement }: ScreenActionsProps) {
  return useScreenActions(actions, { placement });
}
