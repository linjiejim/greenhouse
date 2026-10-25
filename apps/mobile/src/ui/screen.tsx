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
import { refreshItem } from './refresh';
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
      {actions.length || busy !== undefined ? (
        <Stack.Toolbar placement="right">
          {busy !== undefined ? refreshItem(busy, t('common.loading')) : null}
          {actionButtons(actions)}
        </Stack.Toolbar>
      ) : null}
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
      <Stack.Screen options={{ title, ...(from ? { headerTitle: () => <OriginTitle title={title} from={from} /> } : null) }} />
      <Stack.Toolbar placement="right">
        {busy !== undefined ? refreshItem(busy, t('common.loading')) : null}
        {actionButtons(actions)}
        <Stack.Toolbar.Button
          icon={toolbarIcon('x')}
          accessibilityLabel={t('common.close')}
          separateBackground={closeApart}
          onPress={() => router.back()}
        />
      </Stack.Toolbar>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  origin: { alignItems: 'flex-start', maxWidth: 240 },
  from: { ...typo.caption2, color: c.secondaryLabel },
  title: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
}));
