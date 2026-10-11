/**
 * `AgentChatRow` — a task chat in the drawer's chats section (会话 / Chats; spec
 * docs/specs/20261011-agent-first-class.md §5a, D21). The chats list comes from the sessions
 * (`include=agent_chats`), so the row is shaped like the history rows around it — one line, the
 * chat's title — with the Agent that answers there in front, and the thread row's one signal at the
 * end: "needs you" (an orange badge with the card count) over unread (a dot); a reply going on
 * makes the plant talk. The signals come from the store's task-chat summaries
 * (`GET /api/bots/conversations?kind=task`, read with the threads); none until they are in.
 *
 * Opens as a thread (`/?c=`); the drawer wraps it in the history's long-press menu — pin, tags,
 * rename, delete; never share (D26). One VoiceOver element: "Weekly report, needs you, replying".
 */

import React, { memo } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import type { Session } from '../../shared/greenhouse-types';
import { useT } from '../../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../theme';
import { useFontScaleKey } from '../../ui/font-scale';
import { Badge } from '../../ui/list';
import { rowSignal, sproutyBot, taskChatRow, useBots } from '../store';
import { BotAvatar } from '../ui/bot-avatar';
import { rowPose } from './row-text';

/** The plant beside a one-line row; it follows the text size up to 1.3×, like the thread rows'. */
const AVATAR = 24;
const AVATAR_SCALE_MAX = 1.3;

export const AgentChatRow = memo(function AgentChatRow({
  session,
  current,
  onPress,
}: {
  session: Session;
  /** The chat on screen: highlighted, and never "unread". */
  current: boolean;
  onPress(): void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const fontKey = useFontScaleKey();
  const { fontScale } = useWindowDimensions();
  const botId = session.agent_chat?.bot_id ?? null;
  // the Agent that answers there (no id on the row: the member's Sprouty, the server's default)
  const bot = useBots((s) => (botId ? (s.byId[botId] ?? null) : sproutyBot(s)));
  const summary = useBots((s) => taskChatRow(s, session.id));
  const running = useBots((s) => s.running);
  const signal = summary
    ? rowSignal({ running }, summary, current ? session.id : null)
    : { badge: null, needsYouCount: 0, working: session.id in running };
  const pose = rowPose(signal, bot?.status !== 'archived');
  const title = session.title || t('chat.newConversation');
  const needsYou =
    signal.badge === 'needs_you'
      ? signal.needsYouCount > 1
        ? t('bots.common.needsYouN', { n: signal.needsYouCount })
        : t('bots.common.needsYou')
      : null;
  const unread = signal.badge === 'unread';
  const label = [
    title,
    needsYou ?? (unread ? t('bots.nav.unread') : null),
    signal.working ? t('bots.common.replying') : null,
  ]
    .filter(Boolean)
    .join(t('bots.nav.listSep'));
  const size = Math.round(AVATAR * Math.min(Math.max(fontScale, 1), AVATAR_SCALE_MAX));

  return (
    <Pressable
      key={fontKey}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: current }}
      style={({ pressed }) => [
        styles.row,
        current && { backgroundColor: c.tertiaryFill },
        pressed && { backgroundColor: c.fill },
      ]}
    >
      <BotAvatar bot={bot} size={size} state={pose.state} animate={pose.animate} />
      <Text numberOfLines={1} style={[styles.text, (current || unread) && styles.textStrong]}>
        {title}
      </Text>
      {needsYou ? (
        <Badge label={needsYou} tone="orange" />
      ) : unread ? (
        <View style={[styles.dot, { backgroundColor: c.accent }]} />
      ) : null}
    </Pressable>
  );
});

const useStyles = makeStyles((c) => ({
  // the history row's geometry (../../chat/home-drawer.tsx), so the section reads as one list
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 40,
    paddingHorizontal: space.sm + 2,
    borderRadius: radius.md,
    ...squircle,
  },
  text: { flex: 1, ...typo.body, color: c.label },
  textStrong: { fontWeight: weight.semibold },
  dot: { width: 8, height: 8, borderRadius: 4 },
}));
