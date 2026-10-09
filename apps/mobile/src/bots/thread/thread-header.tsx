/**
 * A Bots thread's native navigation bar (spec §2.5.3 a):
 *
 *   [☰³]      (🌱) Sprouty ›          [⋯]
 *             Browsing github.com
 *
 *  - Left: ☰ opens the drawer, with a system badge counting the other
 *    conversations that need the member (cards + unread) — VoiceOver hears
 *    the count in the button's label ("Open sidebar, 3 need your attention").
 *  - Title view (`ThreadTitle`): the Bot's plant (a group: up to three, the
 *    one speaking first) + the name and a live status line, each truncating
 *    on its own; capped at 1.3× Dynamic Type (the bar has the system's large
 *    content viewer). Tap → the Bot's profile (a DM) / the conversation info
 *    (a group). One VoiceOver button: "Sprouty, Browsing github.com".
 *  - Right: a system menu — a DM: Bot Profile · Conversation Info · Invite a
 *    Bot | New Chat (subtitle: the Bot's name); a group: Conversation Info · Invite a Bot
 *    · Rename Group; both end with Show › (the reply details, global —
 *    src/chat/reply-details-menu.tsx). No ✎ (a thread is not a session), no
 *    share (the server refuses to share Bots conversations), no delete.
 *
 * The title view reads a tiny store the screen publishes to
 * (`publishThreadHeader`, only when a field changed) instead of taking props:
 * the thread re-renders ~30×/s while a reply streams, and re-applying
 * navigation options on every tick would rebuild the native bar (the
 * conversation's `ConversationHeader` memo, same reason). Entries are keyed by
 * session — during the cross-fade between two threads both are mounted. It is
 * set as a composition option (`Stack.Title asChild`), which leaves with the
 * thread, so a chat shown on the same route never inherits it.
 */

import React, { memo } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Stack, useRouter } from 'expo-router';
import { create } from 'zustand';
import { replyDetailsMenu } from '../../chat/reply-details-menu';
import { useT } from '../../lib/i18n';
import { usePrefs } from '../../store/prefs';
import { makeStyles, space, typo, useTheme, weight } from '../../theme';
import { Icon } from '../../ui/core';
import { useFontScaleKey } from '../../ui/font-scale';
import type { PlantState } from '../../ui/plant-avatar/plant-ids';
import { toolbarIcon } from '../../ui/toolbar-icon';
import { AvatarStack } from '../ui/avatar-stack';
import { BotAvatar, type AvatarSource } from '../ui/bot-avatar';
import { drawerButtonLabel, menuBadge } from './thread-screen-model';

/** Navigation-bar text never grows past this Dynamic Type multiple (the system's large content viewer covers it). */
const MAX_FONT_SCALE = 1.3;
/** Room the bar's own buttons take (☰ and ⋯ glass buttons + margins). */
const BAR_BUTTONS_W = 152;

export interface ThreadHeaderState {
  title: string;
  /** The status line, already in the app's language. */
  status: string;
  /** A DM: its Bot; a group: up to three members, the one speaking first (null = not loaded yet). */
  bots: Array<AvatarSource | null>;
  /** The title avatar's pose (a DM's Bot; a group's first — the one speaking). */
  pose: PlantState;
  group: boolean;
  /** A DM's Bot — the title opens its profile. */
  ownerBotId: string | null;
}

const useHeaders = create<{ bySid: Record<string, ThreadHeaderState> }>(() => ({ bySid: {} }));

function sameHeader(a: ThreadHeaderState | undefined, b: ThreadHeaderState): boolean {
  return (
    !!a &&
    a.title === b.title &&
    a.status === b.status &&
    a.pose === b.pose &&
    a.group === b.group &&
    a.ownerBotId === b.ownerBotId &&
    a.bots.length === b.bots.length &&
    a.bots.every((bot, i) => bot === b.bots[i])
  );
}

/** The screen's latest header facts; a no-op when nothing changed. */
export function publishThreadHeader(sessionId: string, next: ThreadHeaderState): void {
  if (sameHeader(useHeaders.getState().bySid[sessionId], next)) return;
  useHeaders.setState((s) => ({ bySid: { ...s.bySid, [sessionId]: next } }));
}

export function dropThreadHeader(sessionId: string): void {
  useHeaders.setState((s) => {
    if (!(sessionId in s.bySid)) return s;
    const bySid = { ...s.bySid };
    delete bySid[sessionId];
    return { bySid };
  });
}

/** The title view: avatar + name + live status. Reads the header store, so it is stable for the bar. */
export function ThreadTitle({ sessionId, fallbackTitle }: { sessionId: string; fallbackTitle: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const header = useHeaders((s) => s.bySid[sessionId]);
  const fontKey = useFontScaleKey();
  const title = header?.title || fallbackTitle;
  const status = header?.status ?? '';
  const open = () => {
    if (!header) return;
    if (!header.group && header.ownerBotId) {
      router.push({ pathname: '/bots/profile', params: { botId: header.ownerBotId, from: sessionId } });
    } else router.push({ pathname: '/bots/info', params: { c: sessionId } });
  };
  return (
    <Pressable
      onPress={open}
      disabled={!header}
      accessibilityRole="button"
      accessibilityLabel={status ? `${title}, ${status}` : title}
      accessibilityHint={header?.group ? t('bots.thread.titleHintGroup') : t('bots.thread.titleHintDm')}
      style={({ pressed }) => [styles.title, { maxWidth: width - BAR_BUTTONS_W }, pressed && styles.pressed]}
    >
      {/* the Bot this thread is with (a group: the one speaking, first) shows how it's doing, and moves */}
      {header?.group ? (
        <AvatarStack bots={header.bots} size={20} max={3} lead={header.pose} />
      ) : (
        <BotAvatar bot={header?.bots[0] ?? null} size={26} state={header?.pose} animate />
      )}
      {/* keyed on the text size: re-measures when Dynamic Type changes (src/ui/font-scale.ts) */}
      <View key={fontKey} style={styles.texts}>
        <View style={styles.nameRow}>
          <Text numberOfLines={1} maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.name}>
            {title}
          </Text>
          <Icon name="chevR" size={9} weight="bold" color={c.tertiaryLabel} />
        </View>
        {status ? (
          <Animated.Text
            key={status}
            entering={FadeIn.duration(180)}
            numberOfLines={1}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            style={styles.status}
          >
            {status}
          </Animated.Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export interface ThreadHeaderActions {
  openDrawer: () => void;
  profile: () => void;
  info: () => void;
  invite: () => void;
  askInChat: () => void;
}

/**
 * Title view + glass toolbar. Memoised: Stack.Toolbar re-applies the
 * navigation options whenever it re-renders, which must not happen on every
 * stream tick — every prop here changes rarely.
 */
export const ThreadHeader = memo(function ThreadHeader({
  sessionId,
  title,
  badge,
  group,
  ownerName,
  canInvite,
  canAsk,
  actions,
}: {
  sessionId: string;
  /** The plain title (the back label / VoiceOver fallback; the title view draws its own). */
  title: string;
  /** Other conversations that need the member (0 = no badge). */
  badge: number;
  group: boolean;
  /** A DM's Bot, for "Ask {name} in a New Chat". */
  ownerName: string | null;
  canInvite: boolean;
  /** A DM whose Bot can still answer a new chat. */
  canAsk: boolean;
  actions: ThreadHeaderActions;
}) {
  const t = useT();
  const details = usePrefs((s) => s.details);
  const setDetail = usePrefs((s) => s.setDetail);
  // UIKit draws the badge but never reads it: the count goes into the label, as on the chat's bar.
  const shownBadge = menuBadge(badge);
  return (
    <>
      <Stack.Screen options={{ title }} />
      {/* composition option: removed with this screen, so the chat surface never inherits it */}
      <Stack.Title asChild>
        <ThreadTitle sessionId={sessionId} fallbackTitle={title} />
      </Stack.Title>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon={toolbarIcon('menu')}
          accessibilityLabel={drawerButtonLabel(t('chat.openDrawer'), shownBadge, {
            badge: (n) => t('bots.nav.menuBadgeA11y', { n }),
            separator: t('bots.nav.listSep'),
          })}
          onPress={actions.openDrawer}
        >
          {shownBadge ? <Stack.Toolbar.Badge>{shownBadge}</Stack.Toolbar.Badge> : null}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon={toolbarIcon('more')} accessibilityLabel={t('common.more')}>
          <Stack.Toolbar.MenuAction icon={toolbarIcon('person')} hidden={group || !ownerName} onPress={actions.profile}>
            {t('bots.thread.profile')}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon={toolbarIcon('msgs')} onPress={actions.info}>
            {t('bots.thread.info')}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon={toolbarIcon('userPlus')} hidden={!canInvite} onPress={actions.invite}>
            {t('bots.thread.invite')}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.Menu inline hidden={group || !canAsk}>
            {/* "New Chat" over the Bot's name: one short line in any language, however long the name */}
            <Stack.Toolbar.MenuAction
              icon={toolbarIcon('compose')}
              subtitle={ownerName ?? undefined}
              onPress={actions.askInChat}
            >
              {t('bots.thread.askInChat')}
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu inline>{replyDetailsMenu(t, details, setDetail)}</Stack.Toolbar.Menu>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
    </>
  );
});

const useStyles = makeStyles((c) => ({
  title: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  pressed: { opacity: 0.55 },
  texts: { flexShrink: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  name: { flexShrink: 1, ...typo.headline, fontWeight: weight.semibold, color: c.label },
  status: { ...typo.caption1, color: c.secondaryLabel },
}));
