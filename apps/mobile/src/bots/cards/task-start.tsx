/**
 * A background-task card's body: the task's title, then its brief — on the
 * card a four-line plain-text preview with "Show More" when it runs longer
 * (expands in place to the Markdown), whole as Markdown in the card sheet.
 * Starting it is the card's decision; at most three tasks run at once
 * (`limit` refusal).
 *
 * Why a plain preview rather than clamping the Markdown: a rendered brief is a
 * stack of blocks (paragraphs, lists, headings — each its own view, with its
 * own gaps and line heights), so no fixed height lands between two lines; a
 * clamp sliced the fourth line through its glyphs once a brief had more than
 * one paragraph. One `Text` with `numberOfLines` truncates on a whole line (with
 * an ellipsis) at any text size.
 *
 * The title and brief are keyed on the text size: on iOS (RN 0.86 Fabric) a Dynamic Type
 * change leaves mounted text measured at the old size — and `onTextLayout`
 * reporting the old lines (facebook/react-native#57512); a fresh mount is
 * measured at the new one.
 */

import React, { useMemo, useState } from 'react';
import { Text, View, useWindowDimensions, type TextLayoutEvent } from 'react-native';
import type { BotRequestView, BotTaskStartPayload } from '../../shared/bots';
import { Markdown } from '../../chat/markdown';
import { PROSE_LINE } from '../../chat/markdown/blocks/text';
import { plainText } from '../../chat/model';
import { useT } from '../../lib/i18n';
import { makeStyles, space, typo, useTheme, weight } from '../../theme';
import { MoreLink } from './card-frame';

/** Lines of brief the card shows before "Show More". */
const BRIEF_LINES = 4;

export function TaskStartBody({ request, full = false }: { request: BotRequestView; full?: boolean }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const payload = request.payload as BotTaskStartPayload;
  const brief = typeof payload.brief === 'string' ? payload.brief.trim() : '';
  // The preview spends its four lines on text: paragraph breaks become line breaks.
  const preview = useMemo(() => plainText(brief).replace(/\n{2,}/g, '\n'), [brief]);
  const [open, setOpen] = useState(false);
  // How many lines the preview takes unclamped (measured by an invisible copy:
  // a clamped Text may report only the lines it shows).
  const [lines, setLines] = useState(0);
  const expanded = full || open;
  const { fontScale } = useWindowDimensions();
  return (
    <>
      {payload.title ? (
        <Text
          key={`title:${fontScale}`}
          style={{ ...typo.body, fontWeight: weight.semibold, color: c.label }}
          selectable={full}
        >
          {payload.title}
        </Text>
      ) : null}
      {brief && expanded ? <Markdown key={`brief:${fontScale}`} source={brief} /> : null}
      {brief && !expanded ? (
        <View key={`preview:${fontScale}`}>
          <Text style={styles.preview} numberOfLines={BRIEF_LINES}>
            {preview}
          </Text>
          <Text
            style={[styles.preview, styles.measure]}
            onTextLayout={(e: TextLayoutEvent) => setLines(e.nativeEvent.lines.length)}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            aria-hidden
          >
            {preview}
          </Text>
        </View>
      ) : null}
      {!full && (open || lines > BRIEF_LINES) ? (
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

const useStyles = makeStyles((c) => ({
  // A Markdown paragraph's type and margins (chat/markdown/blocks/text.tsx `styles.p`), so
  // expanding keeps the first line where it was.
  preview: { ...typo.body, lineHeight: PROSE_LINE, color: c.label, marginVertical: space.xs + 2 },
  measure: { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 },
}));
