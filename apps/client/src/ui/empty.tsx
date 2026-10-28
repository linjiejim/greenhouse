/**
 * Empty / unavailable states, the same on iOS and Android and the same family as the web's
 * EmptyState: Sprouty (asleep when there is nothing here, its error face when a load failed),
 * the title in the brand face, a supporting line, and the one action under it — `onRetry` adds
 * the standard 重试 button (load failures), or pass any `action` (usually a `NativeButton`, e.g.
 * 新建项目). Use for empty lists, no search results, load failures and not-allowed states.
 * Centers itself in the space it's given; pass `style` for list placement.
 */

import React from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useT } from '../lib/i18n';
import { makeStyles, space, typo, useTheme, weight } from '../theme';
import { AssistantAvatar } from './avatar';
import { NativeButton } from './button';
import type { IconName } from './core';

export { LoadingState } from './loading-state';

export function EmptyState({
  title,
  message,
  action,
  onRetry,
  style,
}: {
  /** The subject's symbol. Kept for callers; Sprouty stands in for it so every state reads alike. */
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
      <View accessibilityElementsHidden aria-hidden importantForAccessibility="no-hide-descendants">
        <AssistantAvatar size={64} state={onRetry ? 'error' : 'sleep'} animate={false} />
      </View>
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
  title: { ...typo.title3, fontWeight: weight.semibold, color: c.label, textAlign: 'center', marginTop: space.xs },
  message: { ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center' },
  action: { marginTop: space.md },
}));
