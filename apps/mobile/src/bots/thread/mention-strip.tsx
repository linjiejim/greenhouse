/**
 * The @-mention strip: a glass capsule above the input row (the composer's
 * accessory slot — it takes priority over the task dock) listing the members
 * that match the `@` token at the caret (./use-mention-picker.ts), each a
 * plant + name, then "Invite Another Bot…". A pick replaces the token with
 * "@Name " (selection tick); taps never dismiss the keyboard.
 */

import React, { memo } from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useT } from '../../lib/i18n';
import type { BotView } from '../../shared/bots';
import { HIT, makeStyles, space, typo, useTheme, weight } from '../../theme';
import { Icon } from '../../ui/core';
import { Glass } from '../../ui/glass';
import { BotAvatar } from '../ui/bot-avatar';

export const MentionStrip = memo(function MentionStrip({
  candidates,
  onPick,
  onInvite,
}: {
  candidates: BotView[];
  onPick: (bot: BotView) => void;
  /** Absent where inviting isn't possible (the conversation is full). */
  onInvite?: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)}>
      <Glass style={styles.capsule}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
          contentContainerStyle={styles.items}
        >
          {candidates.map((bot) => (
            <Pressable
              key={bot.id}
              onPress={() => onPick(bot)}
              accessibilityRole="button"
              accessibilityLabel={t('bots.composer.mentionA11y', { name: bot.name })}
              style={({ pressed }) => [styles.item, pressed && styles.pressed]}
            >
              <BotAvatar bot={bot} size={22} animate={false} />
              <Text numberOfLines={1} style={styles.name}>
                {bot.name}
              </Text>
            </Pressable>
          ))}
          {onInvite ? (
            <Pressable
              onPress={onInvite}
              accessibilityRole="button"
              style={({ pressed }) => [styles.item, pressed && styles.pressed]}
            >
              <Icon name="userPlus" size={16} weight="medium" color={c.accent} />
              <Text numberOfLines={1} style={styles.invite}>
                {t('bots.composer.inviteOther')}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </Glass>
    </Animated.View>
  );
});

const useStyles = makeStyles((c) => ({
  capsule: { minHeight: HIT, borderRadius: HIT / 2, overflow: 'hidden', justifyContent: 'center' },
  items: { alignItems: 'center', paddingHorizontal: space.xs },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    minHeight: HIT,
    paddingHorizontal: space.sm + 2,
  },
  pressed: { opacity: 0.55 },
  name: { ...typo.subheadline, fontWeight: weight.medium, color: c.label, maxWidth: 160 },
  invite: { ...typo.subheadline, color: c.accent },
}));
