/**
 * `BotThreadScreen` — a Bots conversation as one ongoing thread, rendered on
 * the home route when `?c=<session>` is set (spec
 * docs/specs/20261008-mobile-bots.md §2.5.3): live status in the title view,
 * multi-speaker transcript, cards, queued sends, two-step Stop.
 *
 * P0 STUB (package B implements it): the nav bar (title + ☰) over the
 * thread's loading state, so the route works end to end before the real
 * screen lands.
 */

import React from 'react';
import { View } from 'react-native';
import { Stack, useNavigation } from 'expo-router';
import { DrawerActions } from 'expo-router/react-navigation';
import { useT } from '../../lib/i18n';
import { makeStyles, useTheme } from '../../theme';
import { LoadingState } from '../../ui/empty';
import { toolbarIcon } from '../../ui/toolbar-icon';
import { useBotThread } from '../use-bot-thread';

export function BotThreadScreen({
  sessionId,
  title,
}: {
  sessionId: string;
  /** Placeholder title until the conversation loads. */
  title: string;
  /** A card to scroll to and highlight (deep links). */
  request: string;
  /** Focus the composer on open. */
  compose: boolean;
}): React.JSX.Element {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const navigation = useNavigation();
  const { snap } = useBotThread(sessionId);
  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: snap.conversation?.title || title }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon={toolbarIcon('menu')}
          accessibilityLabel={t('chat.openDrawer')}
          onPress={() => navigation.dispatch(DrawerActions.openDrawer())}
        />
      </Stack.Toolbar>
      <LoadingState style={styles.root} />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.background },
}));
