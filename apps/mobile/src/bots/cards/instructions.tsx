/**
 * A Bot proposing to change its own instructions (in the card's sheet): the
 * reason, a "+3 lines · −1 line" summary, then the whole line diff (vendored
 * web `lineDiff`): added lines on a green wash with "+", removed ones struck
 * through with "−". VoiceOver reads
 * "Added: …" / "Removed: …" instead of the glyphs. Nothing changes until the
 * member accepts (a Bot rewriting its rules after reading a page would be a
 * persistent injection).
 */

import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import type { BotInstructionsUpdatePayload, BotRequestView } from '../../shared/bots';
import { useT } from '../../lib/i18n';
import { makeStyles, mono, radius, space, squircle, typo, useTheme } from '../../theme';
import { lineDiff } from '../vendor/web-helpers';
import { diffCounts } from './decision';

export function InstructionsBody({ request }: { request: BotRequestView }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const payload = request.payload as BotInstructionsUpdatePayload;
  const counts = diffCounts(payload);
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  return (
    <>
      {reason ? (
        <Text style={styles.reason} selectable>
          {reason}
        </Text>
      ) : null}
      <Text style={styles.summary}>{t('bots.card.diffSummary', counts)}</Text>
      <DiffLines payload={payload} />
    </>
  );
}

function DiffLines({ payload }: { payload: BotInstructionsUpdatePayload }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const { current, instructions } = payload;
  const lines = useMemo(() => lineDiff(current ?? '', instructions ?? ''), [current, instructions]);
  return (
    <View style={styles.diff}>
      {lines.map((line, index) => {
        const added = line.kind === 'added';
        const removed = line.kind === 'removed';
        const label = added
          ? t('bots.card.diffAdded', { text: line.text })
          : removed
            ? t('bots.card.diffRemoved', { text: line.text })
            : line.text;
        return (
          <View
            key={index}
            style={[styles.line, added ? { backgroundColor: c.greenFill } : null]}
            accessible
            accessibilityLabel={label || ' '}
          >
            <Text style={[styles.glyph, { color: added ? c.green : removed ? c.red : c.tertiaryLabel }]}>
              {added ? '+' : removed ? '−' : ' '}
            </Text>
            <Text
              style={[
                styles.lineText,
                removed ? { color: c.secondaryLabel, textDecorationLine: 'line-through' } : null,
                !added && !removed ? { color: c.secondaryLabel } : null,
              ]}
              selectable
            >
              {line.text || ' '}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  reason: { ...typo.body, color: c.label },
  summary: { ...typo.footnote, color: c.secondaryLabel },
  diff: {
    borderRadius: radius.md,
    backgroundColor: c.tertiaryFill,
    paddingVertical: space.xs,
    overflow: 'hidden',
    ...squircle,
  },
  line: { flexDirection: 'row', paddingHorizontal: space.sm, paddingVertical: 1 },
  glyph: { ...typo.footnote, fontFamily: mono, width: 16 },
  lineText: { ...typo.footnote, color: c.label, flex: 1 },
}));
