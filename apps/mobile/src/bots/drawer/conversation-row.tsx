/**
 * `ConversationRow` — one Bots conversation in the drawer (spec
 * docs/specs/20261008-mobile-bots.md §2.5.1), the web sidebar's row in native
 * pieces: the Bot's plant (a group: its first two, overlapped), the title, a
 * one-line preview of the last message, the time — and at most one signal:
 * "needs you" (an orange badge with the card count) over unread (a bold title
 * and the count of new Bot replies in an accent badge — `unread_count`; a dot
 * when only system lines are new, or from a server without the count). A Bot replying right now rewrites the preview to
 * "Replying…" instead of adding a badge; the server's `working` is never shown
 * (D14 — only `running` is the client's truth). Sprouty's DM carries a pin.
 *
 * A DM's plant shows the same signal on its face (./row-text.ts `rowPose`:
 * leaning in for "needs you", talking while it replies, asleep when archived).
 * Only a replying Bot moves — a list that is always in motion is noise (and
 * keeps XCUITest from ever going idle). The row is one VoiceOver element —
 * "Dandy, needs you, last message: …, 3 min ago".
 *
 * Rows are separated by a hairline from the text column on (the section draws
 * it, ./bots-section.tsx); the preview is a size under the title.
 *
 * `width` pins the long-press menu's trigger up front (no measure-then-remount
 * pass, AGENTS «菜单»); without `onMenu` the row has no menu at all.
 */

import React, { memo, useMemo } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { isSproutyBot, type BotConversationSummary } from '../../shared/bots';
import { parseMs } from '../../lib/format';
import { useLocale, useT } from '../../lib/i18n';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../theme';
import { Icon } from '../../ui/core';
import { useFontScaleKey } from '../../ui/font-scale';
import { Badge } from '../../ui/list';
import { NativeMenu, menuSections, type MenuItem } from '../../ui/menu';
import { rowSignal, useBots } from '../store';
import { AvatarStack } from '../ui/avatar-stack';
import { BotAvatar } from '../ui/bot-avatar';
import { conversationReplyable } from '../vendor/web-helpers';
import { rowPose, rowPreview, rowTime, rowTitle, type RowCopy } from './row-text';

/**
 * A DM's plant is as tall as the two text lines beside it (name 22 + preview 18 + 1 ≈ 41 pt), and
 * grows with Dynamic Type like they do (to 1.3×); an old group shows its first two plants overlapped.
 */
/** The server counts unread replies up to this (`unread_count`); at it the badge reads "99+". */
const UNREAD_CAP = 99;
const DM_AVATAR = 40;
const GROUP_AVATAR = 26;
/** Avatars follow the text size up to this factor. */
const AVATAR_SCALE_MAX = 1.3;
/** The leading column: the avatar plus a little air — titles stay aligned. */
function leadWidth(fontScale: number): number {
  return Math.round((DM_AVATAR + space.sm) * Math.min(Math.max(fontScale, 1), AVATAR_SCALE_MAX));
}
/** Where a row's text starts (padding + leading column + gap): separators between rows begin here. */
export function rowTextInset(fontScale: number): number {
  return space.sm + leadWidth(fontScale) + space.sm + 2;
}
/** From the accessibility sizes (AX1 = 1.79×) the time leaves the name's line. */
const TIME_HIDDEN_SCALE = 1.75;

/** The localized copy ./row-text.ts needs — stable until the language changes. */
export function useRowCopy(): RowCopy {
  const t = useT();
  return useMemo<RowCopy>(
    () => ({
      deletedBot: t('bots.common.deletedBot'),
      untitledGroup: t('bots.nav.untitledGroup'),
      archivedName: (name) => t('bots.nav.archivedName', { name }),
      youSaid: (text) => t('bots.common.youSaid', { text }),
      botSaid: (name, text) => t('bots.nav.botSaid', { name, text }),
      noMessages: t('bots.common.noMessages'),
    }),
    [t],
  );
}

/** Long-press menu actions; the caller routes them (the drawer closes first). */
export type RowMenuAction = 'open' | 'profile' | 'markRead';

export const ConversationRow = memo(function ConversationRow({
  row,
  current,
  onPress,
  width,
  onMenu,
}: {
  row: BotConversationSummary;
  /** The thread on screen right now: highlighted, and never "unread". */
  current: boolean;
  onPress(): void;
  /** The row's width (the drawer's `DRAWER_W − 2 × inset`), for the menu trigger. */
  width: number;
  /** Long-press menu: open, the Bot's profile (a DM), mark read. */
  onMenu?: (action: RowMenuAction) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const copy = useRowCopy();
  const locale = useLocale();
  const fontKey = useFontScaleKey();
  const { fontScale } = useWindowDimensions();
  const byId = useBots((s) => s.byId);
  const botsLoaded = useBots((s) => s.botsLoaded);
  const running = useBots((s) => s.running);
  // Before the Bot list is in, every row counts as replyable (a sleeping plant would be a guess).
  const replyable = useBots(
    (s) =>
      row.kind === 'direct' && (!s.botsLoaded || conversationReplyable(row, new Set(s.bots.map((bot) => bot.id)))),
  );

  const dir = useMemo(() => ({ byId, botsLoaded }), [byId, botsLoaded]);
  const title = rowTitle(row, dir, copy);
  const signal = rowSignal({ running }, row, current ? row.session_id : null);
  const preview = signal.working ? t('bots.common.replying') : rowPreview(row, dir, copy);
  const owner = row.owner_bot_id ? (byId[row.owner_bot_id] ?? null) : null;
  const pose = rowPose(signal, replyable);
  const pinned = row.kind === 'direct' && isSproutyBot(owner);
  const unread = signal.badge === 'unread';
  const unreadCount = unread ? (row.unread_count ?? 0) : 0;
  // Short (09:41 · 昨天 · 周二 · 10/1) — it shares the line with the name; at the
  // accessibility sizes it gives the name the whole line (VoiceOver still hears it).
  const fullTime = rowTime(parseMs(row.last_activity_at), Date.now(), locale, t('time.yesterday'));
  const time = fontScale >= TIME_HIDDEN_SCALE ? '' : fullTime;
  const needsYou =
    signal.badge === 'needs_you'
      ? signal.needsYouCount > 1
        ? t('bots.common.needsYouN', { n: signal.needsYouCount })
        : t('bots.common.needsYou')
      : null;

  const a11yLabel = [
    title,
    pinned && t('bots.nav.pinnedA11y'),
    needsYou ?? (unread && (unreadCount > 0 ? t('bots.nav.unreadN', { n: unreadCount }) : t('bots.nav.unread'))),
    signal.working ? preview : t('bots.nav.lastMessage', { text: preview }),
    fullTime,
  ]
    .filter(Boolean)
    .join(t('bots.nav.listSep'));

  const menuItems = useMemo<MenuItem[]>(
    () =>
      menuSections([
        [
          { id: 'open', title: t('bots.nav.open'), icon: 'msg' },
          ...(row.kind === 'direct' ? [{ id: 'profile', title: t('bots.nav.profile'), icon: 'person' as const }] : []),
        ],
        unread ? [{ id: 'markRead', title: t('bots.nav.markRead'), icon: 'checkCircle' }] : [],
      ]),
    [row.kind, unread, t],
  );

  const members = useMemo(() => [...row.members].sort((a, b) => a.position - b.position).slice(0, 2), [row.members]);
  const avatarScale = Math.min(Math.max(fontScale, 1), AVATAR_SCALE_MAX);
  const avatarSize = Math.round(DM_AVATAR * avatarScale);

  const body = (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityState={{ selected: current }}
      style={({ pressed }) => [
        styles.row,
        current && { backgroundColor: c.tertiaryFill },
        pressed && { backgroundColor: c.fill },
      ]}
    >
      <View style={[styles.lead, { width: leadWidth(fontScale) }]}>
        {row.kind === 'direct' ? (
          <BotAvatar bot={owner} size={avatarSize} state={pose.state} animate={pose.animate} />
        ) : (
          <AvatarStack
            bots={members.map((m) => byId[m.bot_id] ?? null)}
            size={Math.round(GROUP_AVATAR * avatarScale)}
            max={2}
          />
        )}
      </View>
      {/* keyed on the text size: re-measures when Dynamic Type changes (src/ui/font-scale.ts) */}
      <View key={fontKey} style={styles.body}>
        <View style={styles.line}>
          {title ? (
            <Text numberOfLines={1} style={[styles.title, (unread || current) && styles.titleStrong]}>
              {title}
            </Text>
          ) : (
            <View style={styles.titleSkeleton} />
          )}
          {pinned ? <Icon name="pin" size={11} color={c.tertiaryLabel} /> : null}
          {time ? <Text style={styles.time}>{time}</Text> : null}
        </View>
        <View style={styles.line}>
          <Text numberOfLines={1} style={[styles.preview, signal.working && { color: c.accent }]}>
            {preview}
          </Text>
          {needsYou ? (
            <Badge label={needsYou} tone="orange" />
          ) : unreadCount > 0 ? (
            <Badge label={unreadCount >= UNREAD_CAP ? `${UNREAD_CAP}+` : String(unreadCount)} tone="accent" />
          ) : unread ? (
            <View style={[styles.dot, { backgroundColor: c.accent }]} />
          ) : null}
        </View>
      </View>
    </Pressable>
  );

  return onMenu ? (
    <NativeMenu trigger="longPress" items={menuItems} onSelect={(id) => onMenu(id as RowMenuAction)} width={width}>
      {body}
    </NativeMenu>
  ) : (
    <View style={{ width }}>{body}</View>
  );
});

const useStyles = makeStyles((c) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    minHeight: HIT + space.md,
    paddingVertical: space.xs + 2,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    ...squircle,
  },
  lead: { alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minWidth: 0, gap: 1 },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  title: { flexShrink: 1, ...typo.body, color: c.label },
  titleStrong: { fontWeight: weight.semibold },
  titleSkeleton: { width: 88, height: 12, marginVertical: 5, borderRadius: 6, backgroundColor: c.tertiaryFill },
  time: { marginLeft: 'auto', ...typo.footnote, color: c.secondaryLabel },
  preview: { flex: 1, ...typo.footnote, color: c.secondaryLabel },
  dot: { width: 8, height: 8, borderRadius: 4 },
}));
