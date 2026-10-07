/**
 * Empty / unavailable states — SwiftUI `ContentUnavailableView` (the system
 * "No Results" layout: large symbol, title, description); Android draws the
 * Material equivalent (./empty.android.tsx, same API). Use for empty
 * lists, no search results, and load failures. Centers itself in the space
 * it's given; pass `style` for list placement.
 *
 * Below the view: `onRetry` adds the standard 重试 button (load failures), or
 * pass any `action` (usually a `NativeButton`, e.g. 新建项目).
 */

import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { ContentUnavailableView, Host } from '@expo/ui/swift-ui';
import { useT } from '../lib/i18n';
import { useTheme } from '../theme';
import { NativeButton } from './button';
import { sfSymbol, type IconName } from './core';
import { useLocaleEnv } from './native-form';

export { LoadingState } from './loading-state';

export function EmptyState({
  icon,
  title,
  message,
  action,
  onRetry,
  style,
}: {
  icon: IconName;
  title: string;
  message?: string;
  /** Optional action under the view (a `NativeButton`). */
  action?: React.ReactNode;
  /** Shows the standard 重试 button (for load failures). */
  onRetry?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { isDark } = useTheme();
  const t = useT();
  const locale = useLocaleEnv();
  const below = action ?? (onRetry ? <NativeButton label={t('common.retry')} icon="refresh" onPress={onRetry} /> : null);
  return (
    <View style={[{ alignItems: 'stretch', paddingVertical: 24 }, style]}>
      <Host matchContents={{ vertical: true }} colorScheme={isDark ? 'dark' : 'light'} modifiers={[locale]}>
        <ContentUnavailableView title={title} systemImage={sfSymbol(icon)} description={message} />
      </Host>
      {below ? <View style={{ alignItems: 'center', marginTop: 8 }}>{below}</View> : null}
    </View>
  );
}

