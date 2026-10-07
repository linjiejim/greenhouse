/**
 * `BotsShelf` — "your Bots" under the new chat's hero (spec
 * docs/specs/20261008-mobile-bots.md §2.5.2, SHOULD): Sprouty, then the three
 * most recent conversations someone can reply in, each a plant and a name; a
 * tap opens that ongoing thread. The same order as the drawer (server order,
 * never re-sorted by attention), so the faces stay where the member left them.
 *
 * Static plants (a shelf is a list), hidden while the keyboard is up (the hero
 * is squeezed then) and until the Bot list has answered — no skeleton shelf.
 */

import React, { useCallback, useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { useKeyboardState } from 'react-native-keyboard-controller';
import type { BotConversationSummary } from '../../shared/bots';
import { useT } from '../../lib/i18n';
import { HIT, makeStyles, space, typo, useTheme } from '../../theme';
import { alertError } from '../../ui/dialogs';
import { useRowCopy } from '../drawer/conversation-row';
import { rowTitle } from '../drawer/row-text';
import { openThread } from '../nav';
import { drawerRows, sproutyBot, sproutyDm, useBots } from '../store';
import { AvatarStack } from '../ui/avatar-stack';
import { BotAvatar } from '../ui/bot-avatar';

/** Conversations after Sprouty. */
const RECENT = 3;
const AVATAR = 44;
const GROUP_AVATAR = 30;
/** Each item's column (names truncate to it). */
const ITEM_W = 68;

export function BotsShelf() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const copy = useRowCopy();
  const keyboardUp = useKeyboardState((s) => s.isVisible);

  const bots = useBots((s) => s.bots);
  const byId = useBots((s) => s.byId);
  const botsLoaded = useBots((s) => s.botsLoaded);
  const conversations = useBots((s) => s.conversations);
  const dir = useMemo(() => ({ byId, botsLoaded }), [byId, botsLoaded]);

  const recent = useMemo(
    () => drawerRows({ bots, byId, botsLoaded, conversations }, { query: '', expanded: true, recent: RECENT }).recent,
    [bots, byId, botsLoaded, conversations],
  );
  const sprouty = sproutyBot({ bots });
  const sproutySid = sproutyDm({ bots, conversations });

  const openSprouty = useCallback(async () => {
    if (!sprouty) return;
    const sid = sproutySid ?? (await useBots.getState().ensureSprouty());
    if (sid) openThread(router, { c: sid, title: sprouty.name });
    else alertError(t('bots.nav.unavailable'));
  }, [sprouty, sproutySid, router, t]);

  if (!botsLoaded || !sprouty || keyboardUp) return null;
  return (
    <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(120)} style={styles.shelf}>
      <Item name={sprouty.name} onPress={() => void openSprouty()}>
        <BotAvatar bot={sprouty} size={AVATAR} animate={false} />
      </Item>
      {recent.slice(0, RECENT).map((row) => (
        <ConversationItem key={row.session_id} row={row} title={rowTitle(row, dir, copy)} />
      ))}
    </Animated.View>
  );
}

function ConversationItem({ row, title }: { row: BotConversationSummary; title: string }) {
  const router = useRouter();
  const byId = useBots((s) => s.byId);
  const members = [...row.members].sort((a, b) => a.position - b.position).slice(0, 2);
  return (
    <Item name={title} onPress={() => openThread(router, { c: row.session_id, title })}>
      {row.kind === 'direct' ? (
        <BotAvatar bot={row.owner_bot_id ? (byId[row.owner_bot_id] ?? null) : null} size={AVATAR} animate={false} />
      ) : (
        <AvatarStack bots={members.map((m) => byId[m.bot_id] ?? null)} size={GROUP_AVATAR} max={2} />
      )}
    </Item>
  );
}

function Item({ name, onPress, children }: { name: string; onPress(): void; children: React.ReactNode }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={name}
      style={({ pressed }) => [styles.item, pressed && { opacity: 0.5 }]}
    >
      <View style={styles.face}>{children}</View>
      <Text numberOfLines={1} style={styles.name}>
        {name}
      </Text>
    </Pressable>
  );
}

const useStyles = makeStyles((c) => ({
  shelf: { flexDirection: 'row', justifyContent: 'center', gap: space.xs, marginTop: space.lg },
  item: { width: ITEM_W, minHeight: HIT, alignItems: 'center', gap: space.xs },
  face: { height: AVATAR, justifyContent: 'center' },
  name: { ...typo.caption1, color: c.secondaryLabel, maxWidth: ITEM_W },
}));
