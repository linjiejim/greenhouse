/**
 * A hand-off (`team.ask`): one Bot passing work to another, drawn as a quiet
 * centred strip so the member can follow the relay — "(🌱)→(🌼) Sprouty asked
 * Dandy: list the PRs". Always one line (the brief as plain text), so the
 * transcript never shifts under it; a tap opens the whole brief in a sheet,
 * rendered as markdown (app/bots/relay.tsx). The target is whatever the asking
 * Bot wrote (an id or a name — the caller resolves both); a name nobody here
 * has is printed as written.
 */

import React, { memo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { plainText } from '../../../chat/model';
import { putHandoff } from '../../../lib/handoff';
import { useT } from '../../../lib/i18n';
import type { BotView } from '../../../shared/bots';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../../theme';
import { Icon } from '../../../ui/core';
import { useFontScaleKey } from '../../../ui/font-scale';
import { BotAvatar, type AvatarSource } from '../../ui/bot-avatar';

/** What the hand-off sheet shows (via the handoff store, kind `relay`). */
export interface RelayPayload {
  from: AvatarSource | null;
  to: AvatarSource | null;
  fromName: string;
  toName: string;
  /** Markdown, as the asking Bot wrote it. */
  brief: string;
}

export const HandoffRow = memo(function HandoffRow({
  from,
  to,
  toLabel,
  brief,
}: {
  from: BotView | undefined;
  to: BotView | undefined;
  /** The target as written (shown when no Bot here answers to it). */
  toLabel: string;
  brief: string;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const fontKey = useFontScaleKey();
  const fromName = from?.name ?? t('bots.common.deletedBot');
  const toName = to?.name ?? toLabel.replace(/^@/, '');
  const line = plainText(brief).replace(/\s+/g, ' ').trim();
  const text = line
    ? t('bots.thread.handoff', { from: fromName, to: toName, brief: line })
    : t('bots.thread.handoffBare', { from: fromName, to: toName });
  const label = line
    ? t('bots.thread.handoffA11y', { from: fromName, to: toName, brief: line })
    : t('bots.thread.handoffBare', { from: fromName, to: toName });
  const open = () => {
    const payload: RelayPayload = { from: from ?? null, to: to ?? null, fromName, toName, brief };
    router.push({ pathname: '/bots/relay', params: { k: putHandoff('relay', payload) } });
  };
  return (
    // keyed on the text size: re-measures when Dynamic Type changes (src/ui/font-scale.ts)
    <View key={fontKey} style={styles.wrap}>
      <Pressable
        onPress={open}
        disabled={!brief}
        accessibilityRole={brief ? 'button' : undefined}
        accessibilityLabel={label}
        accessibilityHint={brief ? t('bots.thread.handoffHint') : undefined}
        style={({ pressed }) => [styles.strip, pressed && styles.pressed]}
      >
        <View style={styles.faces}>
          <BotAvatar bot={from ?? null} size={18} animate={false} />
          <Icon name="chevR" size={9} weight="semibold" color={c.tertiaryLabel} />
          <BotAvatar bot={to ?? null} size={18} animate={false} />
        </View>
        <Text numberOfLines={1} style={styles.text}>
          {/* both languages open the line with the asker's name — set it in bold */}
          <Text style={styles.names}>{fromName}</Text>
          {text.slice(fromName.length)}
        </Text>
      </Pressable>
    </View>
  );
});

const useStyles = makeStyles((c) => ({
  wrap: { alignItems: 'center', paddingHorizontal: space.margin, paddingVertical: space.xs },
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    maxWidth: '100%',
    paddingVertical: space.xs + 2,
    paddingLeft: space.sm,
    paddingRight: space.md,
    borderRadius: radius.lg,
    backgroundColor: c.tertiaryFill,
    ...squircle,
  },
  pressed: { opacity: 0.6 },
  faces: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  text: { flexShrink: 1, ...typo.footnote, color: c.secondaryLabel },
  names: { fontWeight: weight.semibold, color: c.label },
}));
