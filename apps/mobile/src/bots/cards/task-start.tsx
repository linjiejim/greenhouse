/**
 * A background-task card's body: the task's title, then its brief as
 * Markdown — four lines on the card with "Show More" when it runs longer
 * (expands in place), whole in the card sheet. Starting it is the card's
 * decision; at most three tasks run at once (`limit` refusal).
 */

import React, { useState } from 'react';
import { Text, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import type { BotRequestView, BotTaskStartPayload } from '../../shared/bots';
import { Markdown } from '../../chat/markdown';
import { PROSE_LINE } from '../../chat/markdown/blocks/text';
import { useT } from '../../lib/i18n';
import { space, typo, useTheme, weight } from '../../theme';
import { MoreLink } from './card-frame';

/** Lines of brief the card shows before "Show More". */
const BRIEF_LINES = 4;
/**
 * A Markdown paragraph's top / bottom margin (`styles.p` in
 * chat/markdown/blocks/text.tsx — keep in step). Margins stay put under
 * Dynamic Type; line heights grow with it.
 */
const PROSE_GAP = space.xs + 2;

export function TaskStartBody({ request, full = false }: { request: BotRequestView; full?: boolean }) {
  const t = useT();
  const { colors: c } = useTheme();
  const payload = request.payload as BotTaskStartPayload;
  const brief = typeof payload.brief === 'string' ? payload.brief.trim() : '';
  const [open, setOpen] = useState(false);
  // The brief's natural height, measured unclamped inside the clipping box.
  const [height, setHeight] = useState(0);
  const { fontScale } = useWindowDimensions();
  // Four whole paragraph lines at the member's text size (RN scales the
  // paragraph's `lineHeight` by the same factor), the first one a margin down —
  // a fixed height would slice a line through its glyphs as text grows.
  const clampAt = Math.ceil(PROSE_GAP + PROSE_LINE * fontScale * BRIEF_LINES);
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
      {/* more than the clamp plus the last paragraph's bottom margin: there's more to read */}
      {!full && height > clampAt + PROSE_GAP + 1 ? (
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
