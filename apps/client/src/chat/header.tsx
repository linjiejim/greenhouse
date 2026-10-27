import React from 'react';
import { Stack } from 'expo-router';
import { HeaderTitle } from './header-avatar';
import { ScreenActions } from '../ui/screen-actions';
import type { ScreenAction } from '../ui/screen-action-types';
import type { PlantState } from '../ui/plant-avatar/plant-ids';
export interface ChatHeaderProps {
  title: string;
  subtitle: string;
  state: PlantState;
  actions: ScreenAction[];
  sessionId: string | null;
  shared: boolean;
}
export function ChatHeader({ title, subtitle, state, actions }: ChatHeaderProps) {
  return (
    <>
      <Stack.Screen
        options={{ title, headerTitle: () => <HeaderTitle title={title} subtitle={subtitle} state={state} /> }}
      />
      <ScreenActions placement="right" actions={actions} />
    </>
  );
}
