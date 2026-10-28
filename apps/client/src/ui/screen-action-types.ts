import type { SymbolViewProps } from 'expo-symbols';
import type { IconName } from './core';
export interface ScreenAction {
  id: string;
  icon: IconName;
  /** Preserve an existing iOS toolbar glyph when its SF variant differs from the content icon. */
  iosSymbol?: Extract<SymbolViewProps['name'], string>;
  label: string;
  onPress: () => void;
  menu?: readonly ScreenAction[];
  shortcut?: string;
  disabled?: boolean;
  destructive?: boolean;
  separateBackground?: boolean;
  badge?: string;
  busy?: boolean;
  hidden?: boolean;
}
export interface ScreenActionsProps {
  actions: readonly ScreenAction[];
  placement?: 'left' | 'right';
}
