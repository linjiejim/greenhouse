/**
 * Page skeletons. A screen declares its chrome through one of these and fills the rest with the
 * list kit (./list.tsx) and the content kit (Card, Chip, Avatar, FileIcon, EmptyState, Skeleton):
 *
 *  - `Screen` — a page in a tab or the conversation: its title and toolbar buttons in the
 *    native bar (the back button is always the system's).
 *  - `SheetScreen` — an object sheet (src/shell/open-object.ts): title, its actions and ✕ on the
 *    right. ✕ closes this sheet only; the sheets under it stay. Opened from a conversation, it
 *    says so above its title ("From …", src/shell/open-object.ts `OpenOrigin`). With
 *    `closeApart`, ✕ stands alone at the far right and the actions form their own glass group.
 *
 * Both render nothing of their own: the list or scroll view after them stays the screen's root,
 * so large titles collapse and sheets grow when scrolled to the edge.
 */

import React from 'react';
import { Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useT } from '../lib/i18n';
import { makeStyles, typo, useTheme, weight } from '../theme';
import type { IconName } from './core';
import { useScreenActions } from './screen-actions';

export interface ScreenAction {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

interface ScreenProps {
  title: string;
  actions?: readonly ScreenAction[];
  /** A refresh the app started is running with content on screen: a small indicator in the bar (./refresh.tsx). */
  busy?: boolean;
}

interface SheetScreenProps extends ScreenProps {
  /** ✕ gets a glass of its own (iOS 26), apart from the actions' group. */
  closeApart?: boolean;
}

export function Screen({ title, actions = [], busy }: ScreenProps) {
  const t = useT();
  return (
    <>
      <Stack.Screen options={{ title }} />
      {useScreenActions([
        ...(busy !== undefined
          ? [{ id: 'refresh', icon: 'refresh' as const, label: t('common.loading'), onPress: () => {}, busy }]
          : []),
        ...actions.map((a, i) => ({ ...a, id: String(i) })),
      ])}
    </>
  );
}

/** A sheet's title with where it was opened from above it. */
function OriginTitle({ title, from }: { title: string; from: string }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const origin = t('conversation.fromConversation', { title: from });
  return (
    <View style={styles.origin} accessible accessibilityRole="header" accessibilityLabel={`${title}, ${origin}`}>
      <Text style={styles.from} numberOfLines={1}>
        {origin}
      </Text>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
    </View>
  );
}

export function SheetScreen({ title, actions = [], busy, closeApart }: SheetScreenProps) {
  const t = useT();
  const router = useRouter();
  const { from } = useLocalSearchParams<{ from?: string }>();
  return (
    <>
      <Stack.Screen
        options={{ title, ...(from ? { headerTitle: () => <OriginTitle title={title} from={from} /> } : null) }}
      />
      {useScreenActions([
        ...(busy !== undefined
          ? [{ id: 'refresh', icon: 'refresh' as const, label: t('common.loading'), onPress: () => {}, busy }]
          : []),
        ...actions.map((a, i) => ({ ...a, id: String(i) })),
        {
          id: 'close',
          icon: 'x',
          label: t('common.close'),
          separateBackground: closeApart,
          onPress: () => router.back(),
        },
      ])}
    </>
  );
}

const useStyles = makeStyles((c) => ({
  origin: { alignItems: 'flex-start', maxWidth: 240 },
  from: { ...typo.caption2, color: c.secondaryLabel },
  title: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
}));
