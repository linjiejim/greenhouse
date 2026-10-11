/**
 * The start of a thread (only once the whole history is loaded): who this is.
 * A DM: the Bot saying hello (static — in a transcript, motion means "this
 * Bot is talking"), its name, and one quiet line saying the thread keeps its
 * context (the role is in the greeting right below; a quick question goes to
 * New Chat from the drawer or ⋯). A task chat: its Agent saying hello, the
 * chat's title, and that this is a separate chat with that Agent — its own
 * context, apart from the main thread (spec 20261011-agent-first-class §5a). A
 * DM with someone else's public Agent (P4): who shared it, and that they can't
 * read this conversation. A group: its roster, its title, "This is the beginning of …".
 */

import React, { memo } from 'react';
import { Text, View } from 'react-native';
import { useT } from '../../../lib/i18n';
import type { BotView } from '../../../shared/bots';
import { makeStyles, space, typo, useTheme, weight } from '../../../theme';
import { useFontScaleKey } from '../../../ui/font-scale';
import { AvatarStack } from '../../ui/avatar-stack';
import { BotAvatar } from '../../ui/bot-avatar';

export const Intro = memo(function Intro({
  kind,
  title,
  owner,
  members,
  sharedBy,
}: {
  kind: 'direct' | 'task' | 'group' | 'room';
  title: string;
  /** A DM's (a task chat's) Bot (undefined while the directory loads). */
  owner: BotView | undefined;
  /** A group's roster. */
  members: BotView[];
  /** A DM with someone else's public Agent: its owner's name. */
  sharedBy?: string;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  // keyed on the text size: re-measures when Dynamic Type changes (src/ui/font-scale.ts)
  const fontKey = useFontScaleKey();
  const t = useT();
  if (kind === 'group') {
    return (
      <View key={fontKey} style={styles.wrap}>
        <AvatarStack bots={members} size={40} max={5} />
        <Text style={styles.title} numberOfLines={3}>
          {title}
        </Text>
        <Text style={styles.body}>{t('bots.thread.groupStart')}</Text>
      </View>
    );
  }
  const name = owner?.name ?? title;
  const task = kind === 'task';
  return (
    <View key={fontKey} style={styles.wrap}>
      {/* says hi once (a hop), then holds still — the title's plant is the one that stays alive */}
      <BotAvatar bot={owner ?? null} size={64} state="hello" animate />
      <Text style={[styles.title, styles.name]} numberOfLines={task ? 3 : undefined}>
        {task ? title : name}
      </Text>
      <Text style={styles.body}>
        {task
          ? t('bots.thread.taskStart', { name: owner?.name ?? t('bots.card.aBot') })
          : sharedBy
            ? t('bots.thread.sharedStart', { name, owner: sharedBy })
            : t('bots.thread.dmStart', { name })}
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
  title: { ...typo.title3, fontWeight: weight.semibold, color: c.label, textAlign: 'center' },
  name: { marginTop: space.xs },
  body: { ...typo.footnote, color: c.secondaryLabel, textAlign: 'center' },
}));
