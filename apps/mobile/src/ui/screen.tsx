/**
 * Page skeletons. A screen declares its chrome through one of these and fills the rest with the
 * list kit (./list.tsx) and the content kit (Card, Chip, Avatar, FileIcon, EmptyState, Skeleton):
 *
 *  - `Screen` — a page in a tab or the conversation: its title and toolbar buttons in the
 *    native bar (the back button is always the system's).
 *  - `SheetScreen` — an object sheet (src/shell/open-object.ts): title, its actions and ✕ on the
 *    right. ✕ closes this sheet only; the sheets under it stay.
 *
 * Both render nothing of their own: the list or scroll view after them stays the screen's root,
 * so large titles collapse and sheets grow when scrolled to the edge.
 */

import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { useT } from '../lib/i18n';
import type { IconName } from './core';
import { toolbarIcon } from './toolbar-icon';

export interface ScreenAction {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

/** Toolbar buttons must be the toolbar's direct children (expo-router reads them as items). */
function actionButtons(actions: readonly ScreenAction[]) {
  return actions.map((action) => (
    <Stack.Toolbar.Button
      key={action.label}
      icon={toolbarIcon(action.icon)}
      accessibilityLabel={action.label}
      disabled={action.disabled}
      onPress={action.onPress}
    />
  ));
}

export function Screen({ title, actions = [] }: { title: string; actions?: readonly ScreenAction[] }) {
  return (
    <>
      <Stack.Screen options={{ title }} />
      {actions.length ? (
        <Stack.Toolbar placement="right">{actionButtons(actions)}</Stack.Toolbar>
      ) : null}
    </>
  );
}

export function SheetScreen({ title, actions = [] }: { title: string; actions?: readonly ScreenAction[] }) {
  const t = useT();
  const router = useRouter();
  return (
    <>
      <Stack.Screen options={{ title }} />
      <Stack.Toolbar placement="right">
        {actionButtons(actions)}
        <Stack.Toolbar.Button icon={toolbarIcon('x')} accessibilityLabel={t('common.close')} onPress={() => router.back()} />
      </Stack.Toolbar>
    </>
  );
}
