/**
 * A hand-off (`team.ask`): one Bot passing work to another, drawn as a quiet
 * centred strip so the member can follow the relay — "(🌱)→(🌼) Sprouty asked
 * Dandy: list the PRs". One line, tap to read the whole brief. The target is
 * whatever the asking Bot wrote (an id or a name — the caller resolves both);
 * a name nobody here has is printed as written.
 */

import React, { memo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useT } from '../../../lib/i18n';
import type { BotView } from '../../../shared/bots';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../../theme';
import { Icon } from '../../../ui/core';
import { useFontScaleKey } from '../../../ui/font-scale';
import { BotAvatar } from '../../ui/bot-avatar';

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
  const [open, setOpen] = useState(false);
  const fontKey = useFontScaleKey();
  const fromName = from?.name ?? t('bots.common.deletedBot');
  const toName = to?.name ?? toLabel.replace(/^@/, '');
  const text = brief
    ? t('bots.thread.handoff', { from: fromName, to: toName, brief })
    : t('bots.thread.handoffBare', { from: fromName, to: toName });
  const label = brief
    ? t('bots.thread.handoffA11y', { from: fromName, to: toName, brief })
    : t('bots.thread.handoffBare', { from: fromName, to: toName });
  return (
    // keyed on the text size: re-measures when Dynamic Type changes (src/ui/font-scale.ts)
    <View key={fontKey} style={styles.wrap}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        disabled={!brief}
        accessibilityLabel={label}
        style={({ pressed }) => [styles.strip, pressed && styles.pressed]}
      >
        <View style={styles.faces}>
          <BotAvatar bot={from ?? null} size={18} animate={false} />
          <Icon name="chevR" size={9} weight="semibold" color={c.tertiaryLabel} />
          <BotAvatar bot={to ?? null} size={18} animate={false} />
        </View>
        <Text numberOfLines={open ? undefined : 1} style={styles.text}>
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
