/**
 * The start of a thread (only once the whole history is loaded): who this is
 * and what the thread is for. A DM: the Bot saying hello (static — in a
 * transcript, motion means "this Bot is talking"), its name and role, and the
 * line that tells the two Sproutys apart — this is the ongoing conversation;
 * for a quick question, a New Chat (tappable). A group: its roster, its
 * title, "This is the beginning of …".
 */

import React, { memo } from 'react';
import { Text, View } from 'react-native';
import { useT } from '../../../lib/i18n';
import type { BotView } from '../../../shared/bots';
import { makeStyles, space, typo, useTheme, weight } from '../../../theme';
import { AvatarStack } from '../../ui/avatar-stack';
import { BotAvatar } from '../../ui/bot-avatar';

export const Intro = memo(function Intro({
  kind,
  title,
  owner,
  members,
  onNewChat,
}: {
  kind: 'direct' | 'group';
  title: string;
  /** A DM's Bot (undefined while the directory loads). */
  owner: BotView | undefined;
  /** A group's roster. */
  members: BotView[];
  onNewChat: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  if (kind === 'group') {
    return (
      <View style={styles.wrap}>
        <AvatarStack bots={members} size={40} max={5} />
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{t('bots.thread.groupStart', { title })}</Text>
      </View>
    );
  }
  const name = owner?.name ?? title;
  // The line names the way out ("New Chat") — that part is a link.
  const [before, after] = t('bots.thread.dmStart', { name, newChat: '\u0000' }).split('\u0000');
  return (
    <View style={styles.wrap}>
      <BotAvatar bot={owner ?? null} size={80} state="hello" animate={false} />
      <View style={styles.names}>
        <Text style={styles.title}>{name}</Text>
        {owner?.role.trim() ? <Text style={styles.role}>{owner.role.trim()}</Text> : null}
      </View>
      <Text style={styles.body}>
        {before}
        <Text style={styles.link} onPress={onNewChat} accessibilityRole="link">
          {t('bots.thread.dmStartLink')}
        </Text>
        {after}
      </Text>
    </View>
  );
});

const useStyles = makeStyles((c) => ({
  wrap: {
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.xxl,
    paddingTop: space.xl,
    paddingBottom: space.lg,
  },
  names: { alignItems: 'center', gap: space.xxs, marginTop: space.xs },
  title: { ...typo.title2, color: c.label, textAlign: 'center' },
  role: { ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center' },
  body: { ...typo.footnote, color: c.secondaryLabel, textAlign: 'center', marginTop: space.xs },
  link: { color: c.accent, fontWeight: weight.semibold },
}));
