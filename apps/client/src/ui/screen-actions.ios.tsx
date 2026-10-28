import React, { useLayoutEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { createPressRelay } from './press-relay';
import { screenActionIcon } from './screen-action-icon';
import { refreshItem } from './refresh';
import type { ScreenAction, ScreenActionsProps } from './screen-action-types';
export type { ScreenAction } from './screen-action-types';
/**
 * Return native items directly: expo-router does not inspect wrapped toolbar children. Presses go
 * through a relay (./press-relay.ts) so a button tapped before the header catches up still runs
 * the newest handler.
 */
export function useScreenActions(
  actions: readonly ScreenAction[],
  { placement = 'right' }: Omit<ScreenActionsProps, 'actions'> = {},
) {
  const [relay] = useState(createPressRelay);
  useLayoutEffect(() => relay.update(actions));
  return (
    <Stack.Toolbar placement={placement}>
      {actions.map((a) =>
        a.busy !== undefined ? (
          refreshItem(a.busy, a.label)
        ) : a.menu ? (
          <Stack.Toolbar.Menu key={a.id} icon={screenActionIcon(a)} accessibilityLabel={a.label} disabled={a.disabled}>
            {a.menu.map((item) => (
              <Stack.Toolbar.MenuAction
                key={item.id}
                icon={screenActionIcon(item)}
                destructive={item.destructive}
                disabled={item.disabled}
                onPress={relay.press(a.id, item.id)}
              >
                {item.label}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
        ) : (
          <Stack.Toolbar.Button
            key={a.id}
            icon={screenActionIcon(a)}
            accessibilityLabel={a.label}
            disabled={a.disabled}
            separateBackground={a.separateBackground}
            hidden={a.hidden}
            onPress={relay.press(a.id)}
          >
            {a.badge ? <Stack.Toolbar.Badge>{a.badge}</Stack.Toolbar.Badge> : null}
          </Stack.Toolbar.Button>
        ),
      )}
    </Stack.Toolbar>
  );
}
export function ScreenActions({ actions, placement }: ScreenActionsProps) {
  return useScreenActions(actions, { placement });
}
