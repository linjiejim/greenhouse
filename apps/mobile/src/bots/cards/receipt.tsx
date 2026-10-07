/**
 * A settled card, collapsed to one line: the kind's symbol in the outcome's
 * color and what happened — "Allowed · Send the weekly report", "Declined",
 * "Created Curly", "Started · Tidy the notes" (./decision.ts
 * `settledReceipt`). Tapping it opens the card read-only (the host renders
 * the expanded card; its header collapses it again). An expired card that may
 * be re-asked offers "Ask Again" on the line itself — a message to the Bot,
 * never a resurrected request.
 */

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { BotRequestView } from '../../shared/bots';
import { useT } from '../../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme } from '../../theme';
import { NativeButton } from '../../ui/button';
import { Icon } from '../../ui/core';
import { useBots } from '../store';
import { HighlightWash, tr } from './card-frame';
import { CARD_ICON, cardKind, settledReceipt, statusBadge } from './decision';

export function Receipt({
  request,
  highlighted,
  onExpand,
  onAskAgain,
}: {
  request: BotRequestView;
  highlighted?: boolean;
  onExpand: () => void;
  /** Set only when "Ask Again" is offered here (expired, re-askable, a thread that can still send). */
  onAskAgain?: () => void;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const byId = useBots((s) => s.byId);
  const line = tr(
    t,
    settledReceipt(request, (id) => byId[id]?.name),
  );
  const tone = statusBadge(request).tone;
  const color = tone === 'green' ? c.green : tone === 'red' ? c.red : c.secondaryLabel;
  return (
    <View style={styles.wrap}>
      <HighlightWash highlighted={highlighted} radius={radius.lg} />
      <Pressable
        onPress={onExpand}
        accessibilityRole="button"
        accessibilityLabel={line}
        accessibilityState={{ expanded: false }}
        style={({ pressed }) => [styles.row, pressed ? { backgroundColor: c.fill } : null]}
      >
        <Icon name={CARD_ICON[cardKind(request)]} size={15} weight="medium" color={color} />
        <Text style={styles.text} numberOfLines={2}>
          {line}
        </Text>
        {onAskAgain ? null : <Icon name="chevD" size={12} weight="semibold" color={c.tertiaryLabel} />}
      </Pressable>
      {onAskAgain ? (
        <View style={styles.askAgain}>
          <NativeButton label={t('bots.card.askAgain')} size="small" onPress={onAskAgain} />
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.secondaryGroupedBackground,
    borderRadius: radius.lg,
    overflow: 'hidden',
    ...squircle,
  },
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 44,
    paddingVertical: space.sm,
    paddingHorizontal: space.md + space.xxs,
  },
  text: { ...typo.subheadline, color: c.secondaryLabel, flex: 1 },
  askAgain: { paddingRight: space.md },
}));
