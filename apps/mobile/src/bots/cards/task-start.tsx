/**
 * A background-task card's body: the task's title, then its brief as
 * Markdown — four lines on the card with "Show More" when it runs longer
 * (expands in place), whole in the card sheet. Starting it is the card's
 * decision; at most three tasks run at once (`limit` refusal).
 */

import React, { useState } from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';
import type { BotRequestView, BotTaskStartPayload } from '../../shared/bots';
import { Markdown } from '../../chat/markdown';
import { useT } from '../../lib/i18n';
import { typo, useTheme, weight } from '../../theme';
import { MoreLink } from './card-frame';

/** Lines of brief the card shows before "Show More". */
const BRIEF_LINES = 4;

export function TaskStartBody({ request, full = false }: { request: BotRequestView; full?: boolean }) {
  const t = useT();
  const { colors: c } = useTheme();
  const payload = request.payload as BotTaskStartPayload;
  const brief = typeof payload.brief === 'string' ? payload.brief.trim() : '';
  const [open, setOpen] = useState(false);
  // The brief's natural height, measured unclamped inside the clipping box.
  const [height, setHeight] = useState(0);
  const clampAt = Math.ceil((typo.body.lineHeight ?? 22) * BRIEF_LINES);
  const clamped = !full && !open;
  return (
    <>
      {payload.title ? (
        <Text style={{ ...typo.body, fontWeight: weight.semibold, color: c.label }} selectable={full}>
          {payload.title}
        </Text>
      ) : null}
      {brief ? (
        <View style={clamped ? { maxHeight: clampAt, overflow: 'hidden' } : null}>
          <View onLayout={(e: LayoutChangeEvent) => setHeight(e.nativeEvent.layout.height)}>
            <Markdown source={brief} />
          </View>
        </View>
      ) : null}
      {!full && height > clampAt + 1 ? (
        <MoreLink
          label={open ? t('bots.card.showLess') : t('bots.card.showMore')}
          expands
          expanded={open}
          onPress={() => setOpen((v) => !v)}
        />
      ) : null}
    </>
  );
}
