/**
 * Empty / unavailable states — Android. Material has no system "content
 * unavailable" view, so this is its empty-state layout: a large Material
 * Symbol, a title and a supporting line, the action (重试 / 新建…) below.
 * Same API as ./empty.tsx (iOS: SwiftUI `ContentUnavailableView`).
 */

import React from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useT } from '../lib/i18n';
import { makeStyles, space, typo, useTheme } from '../theme';
import { NativeButton } from './button';
import { Icon, type IconName } from './core';

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
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const below = action ?? (onRetry ? <NativeButton label={t('common.retry')} icon="refresh" onPress={onRetry} /> : null);
  return (
    <View style={[styles.root, style]}>
      <Icon name={icon} size={48} color={c.secondaryLabel} />
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {below ? <View style={styles.action}>{below}</View> : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { alignItems: 'center', paddingVertical: space.xxl, paddingHorizontal: space.xxl, gap: space.sm },
  title: { ...typo.title3, color: c.label, textAlign: 'center', marginTop: space.sm },
  message: { ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center' },
  action: { marginTop: space.md },
}));
